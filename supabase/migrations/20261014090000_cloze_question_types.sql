-- v2.0.0: 단답형(빈칸) 문제 지원. 추가만 하는 비파괴 변경 (기존 행·함수 시그니처 유지).
--  * attempts: question_type('ox'|'cloze', 기본 'ox'), cloze_id, user_text(입력한 답), overridden('정답으로 인정' 여부)
--    단답형 응답은 shown_type='O'(정지문 기반), user_answer=null 로 저장하고 실제 입력은 user_text 에 둠
--    → 기존 check 제약(shown_type/user_answer ∈ O,X)을 바꾸지 않음.
--  * rounds: question_types('ox'|'cloze'|'mixed', 기본 'ox'), blank_display('count'|'hidden'|null),
--            cloze_attempted / cloze_correct (라운드 안 단답형 문항 수·정답 수)
--  * record_attempt_v2: 새 컬럼까지 받는 버전. 기존 record_attempt 는 그대로 두어 캐시된 구버전 앱도 계속 동작.
--  * 단답형 숨김은 기존 hidden_variants 를 그대로 사용 (variant_id = '<정지문ID>-c1').
--    오답노트의 last_variant_id 에도 단답형 ID 가 들어갈 수 있음 ('-c<숫자>' 로 끝나면 단답형).

alter table public.attempts
  add column if not exists question_type text not null default 'ox',
  add column if not exists cloze_id      text,
  add column if not exists user_text     text,
  add column if not exists overridden    boolean not null default false;

alter table public.rounds
  add column if not exists question_types  text not null default 'ox',
  add column if not exists blank_display   text,
  add column if not exists cloze_attempted int  not null default 0,
  add column if not exists cloze_correct   int  not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'attempts_question_type_check') then
    alter table public.attempts add constraint attempts_question_type_check check (question_type in ('ox', 'cloze'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'attempts_user_text_len_check') then
    alter table public.attempts add constraint attempts_user_text_len_check check (user_text is null or char_length(user_text) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_question_types_check') then
    alter table public.rounds add constraint rounds_question_types_check check (question_types in ('ox', 'cloze', 'mixed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_blank_display_check') then
    alter table public.rounds add constraint rounds_blank_display_check check (blank_display is null or blank_display in ('count', 'hidden'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rounds_cloze_counts_check') then
    alter table public.rounds add constraint rounds_cloze_counts_check check (cloze_attempted >= 0 and cloze_correct >= 0);
  end if;
end $$;

-- ---------------------------------------------------------------- record_attempt_v2
-- 규칙은 record_attempt 와 동일 (오답: 추가/재활성화·dismissed 해제, 오답노트 모드 정답: streak, 일반 모드 정답: 변화 없음)
create or replace function public.record_attempt_v2(
  p_client_id     uuid,
  p_item_id       text,
  p_variant_id    text,
  p_shown_type    text,
  p_user_answer   text,
  p_correct       boolean,
  p_timed_out     boolean,
  p_mode          text,
  p_round_id      uuid,
  p_created_at    timestamptz default now(),
  p_clear_streak  int default 2,
  p_question_type text default 'ox',
  p_cloze_id      text default null,
  p_user_text     text default null,
  p_overridden    boolean default false
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
                               correct, timed_out, mode, round_id, created_at,
                               question_type, cloze_id, user_text, overridden)
  values (p_client_id, v_uid, p_item_id, p_variant_id, p_shown_type, p_user_answer,
          p_correct, coalesce(p_timed_out, false), p_mode, p_round_id, coalesce(p_created_at, now()),
          coalesce(p_question_type, 'ox'), p_cloze_id, left(p_user_text, 200), coalesce(p_overridden, false))
  on conflict (user_id, client_id) do nothing
  returning id into v_inserted;

  if v_inserted is null then
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
          dismissed       = false,
          dismissed_at    = null,
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
revoke execute on function public.record_attempt_v2(uuid, text, text, text, text, boolean, boolean, text, uuid, timestamptz, int, text, text, text, boolean) from public, anon;
grant execute on function public.record_attempt_v2(uuid, text, text, text, text, boolean, boolean, text, uuid, timestamptz, int, text, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------- 관리자 집계 뷰: 문제 유형 컬럼 추가 (기존 컬럼 순서 유지, 끝에 추가)
create or replace view private.hidden_variant_counts as
select variant_id,
       item_id,
       count(*)::int   as hide_count,
       min(created_at) as first_hidden_at,
       max(created_at) as last_hidden_at,
       case when variant_id ~ '-c[0-9]+$' then 'cloze' else 'ox' end as question_type
  from public.hidden_variants
 group by variant_id, item_id;
revoke all on private.hidden_variant_counts from public, anon, authenticated;
