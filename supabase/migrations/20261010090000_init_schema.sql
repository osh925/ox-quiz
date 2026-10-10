-- OX 퀴즈: 사용자 프로필 / 라운드 / 응답 / 오답노트 스키마 + RLS
-- 모든 테이블은 "본인 행만" 읽고 쓸 수 있음 (auth.uid() = user_id).

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  nickname      text not null check (char_length(nickname) between 1 and 40),
  nickname_norm text not null unique,
  created_at    timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);

-- auth.users 생성 시 프로필 자동 생성 (가입 Edge Function 이 user_metadata 에 nickname/nickname_norm 을 넣음)
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, nickname, nickname_norm)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'nickname', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data ->> 'nickname_norm', ''), lower(new.email))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- rounds
create table public.rounds (
  id          uuid primary key,                        -- 클라이언트가 생성 (오프라인 큐 재시도 시 멱등)
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode        text not null check (mode in ('normal', 'wrongnote')),
  timer_sec   int  not null default 0 check (timer_sec >= 0),
  total       int  not null check (total between 1 and 100),
  correct     int  not null default 0 check (correct >= 0),
  timeouts    int  not null default 0 check (timeouts >= 0),
  attempted   int  not null default 0 check (attempted >= 0),
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index rounds_user_started_idx on public.rounds (user_id, started_at desc);
alter table public.rounds enable row level security;
create policy "rounds: read own"   on public.rounds for select to authenticated using ((select auth.uid()) = user_id);
create policy "rounds: insert own" on public.rounds for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "rounds: update own" on public.rounds for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- attempts
create table public.attempts (
  id          bigint generated always as identity primary key,
  client_id   uuid not null,                           -- 클라이언트 생성 ID (재시도 중복 방지)
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id     text not null,                           -- 정지문 고정 ID
  variant_id  text,                                    -- 오지문 ID (정지문 출제면 null)
  shown_type  text not null check (shown_type in ('O', 'X')),
  user_answer text check (user_answer in ('O', 'X')),  -- null = 시간 초과
  correct     boolean not null,
  timed_out   boolean not null default false,
  mode        text not null check (mode in ('normal', 'wrongnote')),
  round_id    uuid references public.rounds (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (user_id, client_id)
);
create index attempts_user_created_idx on public.attempts (user_id, created_at desc);
create index attempts_round_idx on public.attempts (round_id);
alter table public.attempts enable row level security;
create policy "attempts: read own"   on public.attempts for select to authenticated using ((select auth.uid()) = user_id);
create policy "attempts: insert own" on public.attempts for insert to authenticated with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- wrong_notes
create table public.wrong_notes (
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id          text not null,                      -- 묶음 단위 = 정지문
  wrong_count      int  not null default 0,
  last_wrong_at    timestamptz,
  correct_streak   int  not null default 0,            -- 오답노트 모드에서 연속 정답 수
  cleared          boolean not null default false,
  cleared_at       timestamptz,
  last_variant_id  text,                               -- 마지막으로 틀린 오지문 ID (정지문을 틀렸으면 null)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, item_id)
);
create index wrong_notes_active_idx on public.wrong_notes (user_id) where not cleared;
alter table public.wrong_notes enable row level security;
create policy "wrong_notes: read own"   on public.wrong_notes for select to authenticated using ((select auth.uid()) = user_id);
create policy "wrong_notes: insert own" on public.wrong_notes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "wrong_notes: update own" on public.wrong_notes for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------- record_attempt (원자적: 응답 저장 + 오답노트 갱신)
-- 규칙 (js/quiz-core.js 의 applyWrongNote 와 동일):
--  * 오답(시간 초과 포함): 어떤 모드든 wrong_count+1, streak=0, cleared=false, last_variant_id 갱신
--  * 정답 + 오답노트 모드: 활성 항목이면 streak+1, streak >= p_clear_streak 이면 cleared=true
--  * 정답 + 일반 모드: 변화 없음
-- SECURITY INVOKER: RLS 가 그대로 적용됨. 같은 client_id 로 다시 호출하면 아무것도 바꾸지 않음(멱등).
create or replace function public.record_attempt(
  p_client_id    uuid,
  p_item_id      text,
  p_variant_id   text,
  p_shown_type   text,
  p_user_answer  text,
  p_correct      boolean,
  p_timed_out    boolean,
  p_mode         text,
  p_round_id     uuid,
  p_created_at   timestamptz default now(),
  p_clear_streak int default 2
)
returns public.wrong_notes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inserted bigint;
  v_note public.wrong_notes;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.attempts (client_id, user_id, item_id, variant_id, shown_type, user_answer,
                               correct, timed_out, mode, round_id, created_at)
  values (p_client_id, v_uid, p_item_id, p_variant_id, p_shown_type, p_user_answer,
          p_correct, coalesce(p_timed_out, false), p_mode, p_round_id, coalesce(p_created_at, now()))
  on conflict (user_id, client_id) do nothing
  returning id into v_inserted;

  if v_inserted is null then
    -- 이미 처리된 요청 (재시도) → 현재 상태만 반환
    select * into v_note from public.wrong_notes where user_id = v_uid and item_id = p_item_id;
    return v_note;
  end if;

  if not p_correct then
    insert into public.wrong_notes as w (user_id, item_id, wrong_count, last_wrong_at, correct_streak,
                                         cleared, cleared_at, last_variant_id, updated_at)
    values (v_uid, p_item_id, 1, coalesce(p_created_at, now()), 0, false, null, p_variant_id, now())
    on conflict (user_id, item_id) do update
      set wrong_count     = w.wrong_count + 1,
          last_wrong_at   = excluded.last_wrong_at,
          correct_streak  = 0,
          cleared         = false,
          cleared_at      = null,
          last_variant_id = excluded.last_variant_id,
          updated_at      = now()
    returning * into v_note;
  elsif p_mode = 'wrongnote' then
    update public.wrong_notes w
       set correct_streak = w.correct_streak + 1,
           cleared        = (w.correct_streak + 1) >= greatest(p_clear_streak, 1),
           cleared_at     = case when (w.correct_streak + 1) >= greatest(p_clear_streak, 1) then now() else null end,
           updated_at     = now()
     where w.user_id = v_uid and w.item_id = p_item_id and not w.cleared
    returning * into v_note;
    if v_note is null then
      select * into v_note from public.wrong_notes where user_id = v_uid and item_id = p_item_id;
    end if;
  else
    select * into v_note from public.wrong_notes where user_id = v_uid and item_id = p_item_id;
  end if;

  return v_note;
end;
$$;

revoke execute on function public.record_attempt(uuid, text, text, text, text, boolean, boolean, text, uuid, timestamptz, int) from public, anon;
grant execute on function public.record_attempt(uuid, text, text, text, text, boolean, boolean, text, uuid, timestamptz, int) to authenticated;

-- 비로그인(anon) 역할은 테이블에 접근할 일이 없음 (방어적 권한 회수)
revoke all on table public.profiles, public.rounds, public.attempts, public.wrong_notes from anon;
