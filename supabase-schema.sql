-- ============================================================
-- Supabase スキーマ v4 (一人利用 / 行レベルセキュリティ)
-- Supabase ダッシュボード > SQL Editor に貼り付けて実行する
-- 変更点: items.box_id を nullable に (null = Inbox = 未分類)。
--         箱を削除しても中のタスクは消えず Inbox へ戻る (on delete set null)。
-- ============================================================

-- プロジェクト(箱) / 付箋
create table if not exists boxes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title      text not null default '',
  x          double precision not null default 0,
  y          double precision not null default 0,
  w          double precision not null default 280,
  h          double precision,                         -- null = 高さ自動
  collapsed  boolean not null default false,
  hue        integer not null default 210,
  type       text not null default 'project',          -- 'project' or 'note'(付箋)
  body       text not null default '',                 -- 付箋本文 / プロジェクト全体メモ
  created_at timestamptz not null default now()
);

-- タスク (box_id が null のものは Inbox = 未分類)
create table if not exists items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  box_id     uuid references boxes(id) on delete set null,  -- null許可。箱削除でInboxへ
  text       text not null default '',
  date       date,                                     -- null = 日付なし
  done       boolean not null default false,
  starred    boolean not null default false,           -- ★重要タスク
  memo       text not null default '',                 -- 一行メモ
  detail     text not null default '',                 -- 複数行メモ
  repeat     jsonb not null default '{"freq":"none","interval":1,"weekdays":[]}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists items_box_id_idx on items(box_id);

-- ============================================================
-- 行レベルセキュリティ: ログインユーザーは自分の行だけ読み書き
-- ============================================================
alter table boxes enable row level security;
alter table items enable row level security;

create policy "own boxes" on boxes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own items" on items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 【旧バージョンのテーブルを作成済みの場合のみ】以下を実行して移行する
-- 新規作成なら上のCREATEに全て含まれるため実行不要
-- ============================================================
-- alter table boxes add column if not exists type text not null default 'project';
-- alter table boxes add column if not exists body text not null default '';
-- alter table items add column if not exists starred boolean not null default false;
-- alter table items alter column box_id drop not null;
-- alter table items drop constraint if exists items_box_id_fkey;
-- alter table items add constraint items_box_id_fkey
--   foreign key (box_id) references boxes(id) on delete set null;
