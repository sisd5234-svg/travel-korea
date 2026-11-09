-- ============================================================================
-- 여행 동선 플래너 - Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 Run 하세요. (여러 번 실행해도 안전)
-- ============================================================================

-- 1. 여행 테이블 ------------------------------------------------------------
--    한 여행 = 한 행. 일차/행선지는 days(jsonb)에 통째로 저장해서
--    저장할 때 여행 하나가 항상 한 번에(원자적으로) 바뀌도록 함.
create table if not exists public.trips (
  id          text primary key,
  title       text not null,
  start_date  date,
  end_date    date,
  days        jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

-- 수정 시각 / 수정자 자동 기록
create or replace function public.touch_trip()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trips_touch on public.trips;
create trigger trips_touch
  before insert or update on public.trips
  for each row execute function public.touch_trip();

-- 2. 관리자 목록 ------------------------------------------------------------
--    로그인만 했다고 수정할 수 있는 게 아니라, 이 표에 등록된 사람만 쓰기 가능.
create table if not exists public.admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- 현재 로그인한 사용자가 관리자인지 (RLS 정책과 화면에서 같이 사용)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 3. Row Level Security -----------------------------------------------------
alter table public.trips  enable row level security;
alter table public.admins enable row level security;

drop policy if exists "trips: 누구나 읽기"     on public.trips;
drop policy if exists "trips: 관리자만 추가"   on public.trips;
drop policy if exists "trips: 관리자만 수정"   on public.trips;
drop policy if exists "trips: 관리자만 삭제"   on public.trips;

create policy "trips: 누구나 읽기"
  on public.trips for select
  to anon, authenticated
  using (true);

create policy "trips: 관리자만 추가"
  on public.trips for insert
  to authenticated
  with check ((select public.is_admin()));

create policy "trips: 관리자만 수정"
  on public.trips for update
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "trips: 관리자만 삭제"
  on public.trips for delete
  to authenticated
  using ((select public.is_admin()));

-- admins 표는 정책을 두지 않음 = API로는 아무도 읽기/쓰기 불가.
-- (관리자 추가는 아래 4번처럼 SQL Editor에서만)

-- 4. 권한(grant) -------------------------------------------------------------
revoke all on public.trips  from anon, authenticated;
revoke all on public.admins from anon, authenticated;
grant select                         on public.trips to anon, authenticated;
grant insert, update, delete         on public.trips to authenticated;

revoke all     on function public.is_admin() from public;
grant execute  on function public.is_admin() to anon, authenticated;

-- 5. 경유 규칙 ------------------------------------------------------------
--    "이 장소(반경 radius_m 안)에 들어오거나 나갈 때는 항상 이 지점을 경유" 규칙.
--    도로 경로를 계산할 때(관리자 화면) 해당 구간에 경유지를 끼워 넣어 계산함.
--    in_* = 들어올 때(이전 장소 -> 경유지 -> 이 장소), out_* = 나갈 때(이 장소 -> 경유지 -> 다음 장소)
--    in/out 중 비워 둔 쪽은 규칙 없음. 경로 계산에만 쓰이므로 관리자만 읽고 쓸 수 있음.
create table if not exists public.route_rules (
  id          bigint generated always as identity primary key,
  name        text not null,
  lat         double precision not null,
  lng         double precision not null,
  radius_m    integer not null default 50 check (radius_m between 5 and 2000),
  in_name     text,
  in_lat      double precision,
  in_lng      double precision,
  out_name    text,
  out_lat     double precision,
  out_lng     double precision,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((in_lat is null) = (in_lng is null)),
  check ((out_lat is null) = (out_lng is null))
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists route_rules_touch on public.route_rules;
create trigger route_rules_touch
  before update on public.route_rules
  for each row execute function public.touch_updated_at();

alter table public.route_rules enable row level security;

drop policy if exists "route_rules: 관리자만 읽기" on public.route_rules;
drop policy if exists "route_rules: 관리자만 추가" on public.route_rules;
drop policy if exists "route_rules: 관리자만 수정" on public.route_rules;
drop policy if exists "route_rules: 관리자만 삭제" on public.route_rules;

create policy "route_rules: 관리자만 읽기"
  on public.route_rules for select to authenticated
  using ((select public.is_admin()));
create policy "route_rules: 관리자만 추가"
  on public.route_rules for insert to authenticated
  with check ((select public.is_admin()));
create policy "route_rules: 관리자만 수정"
  on public.route_rules for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "route_rules: 관리자만 삭제"
  on public.route_rules for delete to authenticated
  using ((select public.is_admin()));

revoke all on public.route_rules from anon, authenticated;
grant select, insert, update, delete on public.route_rules to authenticated;

-- 첫 규칙: 흑석로3길 23(중앙하이츠)에 들어오고 나갈 때 중앙대학교 사범대학 부속유치원 경유
insert into public.route_rules (name, lat, lng, radius_m, in_name, in_lat, in_lng, out_name, out_lat, out_lng)
select '흑석로3길 23 (중앙하이츠)', 37.507624, 126.955707, 50,
       '중앙대학교 사범대학 부속유치원', 37.506424, 126.955473,
       '중앙대학교 사범대학 부속유치원', 37.506424, 126.955473
where not exists (select 1 from public.route_rules where name = '흑석로3길 23 (중앙하이츠)');

-- ============================================================================
-- 6. 관리자 등록 (계정을 만든 뒤 한 번만 실행)
--    Authentication > Users 에서 관리자 계정을 만든 다음, 이메일을 바꿔서 실행:
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = '관리자@이메일.com'
--    on conflict do nothing;
-- ============================================================================
