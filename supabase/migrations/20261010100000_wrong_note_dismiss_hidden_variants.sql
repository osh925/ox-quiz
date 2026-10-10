-- 오답노트 삭제(dismiss) + 사용자별 숨긴 오지문(hidden_variants) + 관리자용 집계 뷰
-- 추가 전용(additive) 마이그레이션: 기존 데이터는 바꾸지 않음.

-- ---------------------------------------------------------------- wrong_notes: 사용자가 직접 삭제한 표시
alter table public.wrong_notes
  add column if not exists dismissed    boolean not null default false,
  add column if not exists dismissed_at timestamptz;
-- 삭제 = cleared=true + dismissed=true (활성 목록에서 빠짐). 나중에 다시 틀리면 record_attempt 가 둘 다 되돌림.

-- ---------------------------------------------------------------- hidden_variants
create table if not exists public.hidden_variants (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  variant_id text not null,             -- 오지문 ID (예: civpro1-mid-0013-1)
  item_id    text not null,             -- 정지문 ID (예: civpro1-mid-0013)
  created_at timestamptz not null default now(),
  primary key (user_id, variant_id)
);
alter table public.hidden_variants enable row level security;
drop policy if exists "hidden_variants: read own" on public.hidden_variants;
drop policy if exists "hidden_variants: insert own" on public.hidden_variants;
drop policy if exists "hidden_variants: delete own" on public.hidden_variants;
create policy "hidden_variants: read own"   on public.hidden_variants for select to authenticated using ((select auth.uid()) = user_id);
create policy "hidden_variants: insert own" on public.hidden_variants for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "hidden_variants: delete own" on public.hidden_variants for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.hidden_variants from anon;

-- ---------------------------------------------------------------- dismiss_wrong_note (원자적: 오답노트 삭제 + 선택한 오지문 숨김)
create or replace function public.dismiss_wrong_note(p_item_id text, p_hide_variants text[] default '{}')
returns public.wrong_notes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_note public.wrong_notes;
  v text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.wrong_notes w
     set cleared = true, dismissed = true, dismissed_at = now(), correct_streak = 0, updated_at = now()
   where w.user_id = v_uid and w.item_id = p_item_id
  returning * into v_note;

  foreach v in array coalesce(p_hide_variants, '{}') loop
    -- 오지문 ID 는 '<정지문ID>-<가지번호>' 형식이어야 함
    if v like p_item_id || '-%' then
      insert into public.hidden_variants (user_id, variant_id, item_id)
      values (v_uid, v, p_item_id)
      on conflict (user_id, variant_id) do nothing;
    end if;
  end loop;

  return v_note;
end;
$$;
revoke execute on function public.dismiss_wrong_note(text, text[]) from public, anon;
grant execute on function public.dismiss_wrong_note(text, text[]) to authenticated;

-- ---------------------------------------------------------------- record_attempt: 다시 틀리면 dismissed 도 해제 (시그니처 동일, 내용만 교체)
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
                                         cleared, cleared_at, last_variant_id, dismissed, dismissed_at, updated_at)
    values (v_uid, p_item_id, 1, coalesce(p_created_at, now()), 0, false, null, p_variant_id, false, null, now())
    on conflict (user_id, item_id) do update
      set wrong_count     = w.wrong_count + 1,
          last_wrong_at   = excluded.last_wrong_at,
          correct_streak  = 0,
          cleared         = false,
          cleared_at      = null,
          last_variant_id = excluded.last_variant_id,
          dismissed       = false,
          dismissed_at    = null,
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


-- ---------------------------------------------------------------- 관리자용: 오지문별 숨김 집계
-- private 스키마는 API 로 노출되지 않고 anon/authenticated 에게 USAGE 권한도 없음 → 대시보드 SQL Editor(postgres)에서만 조회 가능.
-- 뷰는 소유자(postgres) 권한으로 실행되어 전체 사용자를 집계하지만, 사용자 ID 는 내보내지 않음.
create or replace view private.hidden_variant_counts as
select variant_id,
       item_id,
       count(*)::int      as hide_count,
       min(created_at)    as first_hidden_at,
       max(created_at)    as last_hidden_at
  from public.hidden_variants
 group by variant_id, item_id;
revoke all on private.hidden_variant_counts from public, anon, authenticated;
