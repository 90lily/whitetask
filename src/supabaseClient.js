import { createClient } from "@supabase/supabase-js";

// .env の値を読み込む。VITE_ プレフィックスの変数だけがフロントに露出する。
// anon key はフロントに出るのが前提の公開鍵。データはRLS(行レベルセキュリティ)で守る。
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を .env に設定してください");
}

export const supabase = createClient(url, anonKey);
