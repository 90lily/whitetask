import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { supabase } from "./supabaseClient";

/*
 * 空間ボード v4
 * - items をフラット配列に変更 (box_id で箱に所属 / null = Inbox)
 * - 仮想Inbox: box_id=null のタスクが自動で集まる抽出ビュー (物理箱なし)
 * - プロジェクト間移動: box_id の書き換え (Inbox⇄箱, 箱⇄箱)
 * - スマホ(幅700px以下): 「今やること」/「全体」の切替リスト表示 (localStorage永続)
 * - Todoist連携は削除 (タスクの正はSupabase一本)
 */

// ---- UIプレファレンス永続化 (独立アプリなので localStorage 可) ----
const lsGet = (k, def) => { try{ const v=localStorage.getItem(k); return v===null?def:JSON.parse(v); }catch{ return def; } };
const lsSet = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} };

// ---- 日付ユーティリティ ----
const startOfDay = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const toStr = (x) => `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
const parseDate = (s) => { if (!s) return null; const [y,m,d] = s.split("-").map(Number); return startOfDay(new Date(y,m-1,d)); };
const WD_JP = ["日","月","火","水","木","金","土"];
const now0 = () => startOfDay(new Date());
const weekRange = () => { const n=now0(); const mon=new Date(n); mon.setDate(n.getDate()-((n.getDay()+6)%7)); const sun=new Date(mon); sun.setDate(mon.getDate()+6); return [mon,sun]; };
const monthRange = () => { const n=now0(); const first=new Date(n.getFullYear(),n.getMonth(),1); const last=new Date(n.getFullYear(),n.getMonth()+1,0); return [startOfDay(first),startOfDay(last)]; };
const bucketOf = (s) => {
  const t=parseDate(s); if(!t) return null;
  if(+t<+now0()) return "overdue";
  if(+t===+now0()) return "today";
  const [ws,we]=weekRange(); if(+t>=+ws&&+t<=+we) return "week";
  const [ms,me]=monthRange(); if(+t>=+ms&&+t<=+me) return "month";
  return "later";
};
const fmtShort = (s) => { const t=parseDate(s); if(!t) return ""; return `${t.getMonth()+1}/${t.getDate()}(${WD_JP[t.getDay()]})`; };

// ---- 繰り返し ----
const emptyRepeat = () => ({ freq:"none", interval:1, weekdays:[] });
const summarizeRepeat = (r) => {
  if(!r || r.freq==="none") return "";
  const iv=r.interval>1?`${r.interval}`:"";
  if(r.freq==="daily") return `🔁 ${iv?iv+"日ごと":"毎日"}`;
  if(r.freq==="weekly"){
    const wd=r.weekdays||[];
    if(wd.length===5 && [1,2,3,4,5].every(d=>wd.includes(d))) return `🔁 平日`;
    const days=wd.slice().sort().map(d=>WD_JP[d]).join("・");
    return `🔁 ${iv?iv+"週ごと":"毎週"}${days?" "+days:""}`;
  }
  if(r.freq==="monthly") return `🔁 ${iv?iv+"ヶ月ごと":"毎月"}`;
  if(r.freq==="yearly") return `🔁 ${iv?iv+"年ごと":"毎年"}`;
  return "";
};
const nextOccur = (dateStr, r) => {
  const cur = parseDate(dateStr) || now0();
  const iv = Math.max(1, r.interval||1);
  if(r.freq==="daily"){ const d=new Date(cur); d.setDate(d.getDate()+iv); return toStr(d); }
  if(r.freq==="weekly"){
    const wd = r.weekdays||[];
    if(wd.length===0){ const d=new Date(cur); d.setDate(d.getDate()+7*iv); return toStr(d); }
    for(let i=1;i<=7*iv+7;i++){ const d=new Date(cur); d.setDate(d.getDate()+i); if(wd.includes(d.getDay())) return toStr(d); }
    const d=new Date(cur); d.setDate(d.getDate()+7); return toStr(d);
  }
  if(r.freq==="monthly"){ const d=new Date(cur); d.setMonth(d.getMonth()+iv); return toStr(d); }
  if(r.freq==="yearly"){ const d=new Date(cur); d.setFullYear(d.getFullYear()+iv); return toStr(d); }
  return dateStr;
};

// ---- URL抽出 (メモ中のURLをチップ化) ----
const extractUrls = (text) => (text||"").match(/https?:\/\/[^\s]+/g) || [];
const shortUrl = (u) => { try{ const x=new URL(u); return x.hostname.replace(/^www\./,"") + (x.pathname!=="/"?x.pathname:""); }catch{ return u; } };

const HUES = [210,145,28,340,265,48,190,0];
const PALETTE = [210,145,28,340,265,48,190,0,90,300];
const uid = () => crypto.randomUUID();
const mkItem = (o={}) => ({ id:uid(), box_id:null, text:"", date:"", done:false, starred:false, memo:"", detail:"", repeat:emptyRepeat(), ...o });

// ---- DB行 <-> ローカル形式 ----
const dbToItem = (r) => ({ id:r.id, box_id:r.box_id||null, text:r.text||"", date:r.date||"", done:!!r.done, starred:!!r.starred, memo:r.memo||"", detail:r.detail||"", repeat:r.repeat||emptyRepeat() });
const itemToDb = (it) => ({ id:it.id, box_id:it.box_id, text:it.text, date:it.date||null, done:it.done, starred:it.starred, memo:it.memo, detail:it.detail, repeat:it.repeat });
const boxToDb = (b) => ({ id:b.id, title:b.title, x:b.x, y:b.y, w:b.w, h:b.h??null, collapsed:b.collapsed, hue:b.hue, type:b.type||"project", body:b.body||"" });

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [boxes, setBoxes] = useState([]);       // 箱メタ情報のみ (items を持たない)
  const [items, setItems] = useState([]);       // 全タスクのフラット配列
  const [view, setView] = useState({ x:0, y:0, scale:1 });
  const [focusId, setFocusId] = useState(null);
  const [openDetail, setOpenDetail] = useState(null);   // itemId
  const [moveOpen, setMoveOpen] = useState(null);       // itemId (移動先ポップ)
  const [dateOpen, setDateOpen] = useState(null);       // itemId (カレンダーポップ)
  const [paletteFor, setPaletteFor] = useState(null);
  const [noteOpenFor, setNoteOpenFor] = useState(null);
  const [fontScale, setFontScale] = useState(()=>lsGet("sb.fontScale", 1));
  const bumpFont = (d)=>setFontScale(s=>Math.min(1.7,Math.max(0.7,+(s+d).toFixed(2))));
  useEffect(()=>{ lsSet("sb.fontScale", fontScale); },[fontScale]);
  // スマホ判定と表示モード
  const [isMobile, setIsMobile] = useState(()=>window.matchMedia("(max-width:700px)").matches);
  useEffect(()=>{
    const mq = window.matchMedia("(max-width:700px)");
    const f = (e)=>setIsMobile(e.matches);
    mq.addEventListener("change", f);
    return ()=>mq.removeEventListener("change", f);
  },[]);
  const [mobileView, setMobileView] = useState(()=>lsGet("sb.mobileView", "now")); // "now" | "all"
  useEffect(()=>{ lsSet("sb.mobileView", mobileView); },[mobileView]);

  const canvasRef = useRef(null);
  const boxRefs = useRef({});
  const drag = useRef(null);
  const viewRef = useRef(view);
  useEffect(()=>{ viewRef.current=view; },[view]);

  // ---- 認証 ----
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const { data:sub } = supabase.auth.onAuthStateChange((_e,s)=>setSession(s));
    return ()=>sub.subscription.unsubscribe();
  },[]);

  // ---- 初期ロード ----
  useEffect(()=>{
    if(!session){ setLoading(false); return; }
    let alive=true;
    (async()=>{
      setLoading(true);
      const [{ data:bx, error:be }, { data:it, error:ie }] = await Promise.all([
        supabase.from("boxes").select("*").order("created_at",{ascending:true}),
        supabase.from("items").select("*").order("created_at",{ascending:true}),
      ]);
      if(!alive) return;
      if(be||ie){ console.error(be||ie); setLoading(false); return; }
      setBoxes((bx||[]).map(b=>({ id:b.id, title:b.title, x:b.x, y:b.y, w:b.w, h:b.h, collapsed:b.collapsed, hue:b.hue, type:b.type||"project", body:b.body||"" })));
      setItems((it||[]).map(dbToItem));
      setLoading(false);
    })();
    return ()=>{ alive=false; };
  },[session]);

  // ---- 永続化 (ローカル即時 + DB非同期) ----
  const persistBox = (b)=>{ supabase.from("boxes").upsert(boxToDb(b)).then(({error})=>error&&console.error(error)); };
  const persistItem = (it)=>{ supabase.from("items").upsert(itemToDb(it)).then(({error})=>error&&console.error(error)); };
  const removeBoxDb = (id)=>{ supabase.from("boxes").delete().eq("id",id).then(({error})=>error&&console.error(error)); };
  const removeItemDb = (id)=>{ supabase.from("items").delete().eq("id",id).then(({error})=>error&&console.error(error)); };

  // ---- タスク操作 (itemId 基準に統一) ----
  const patchItem = useCallback((itemId, patch)=>{
    setItems(is=>is.map(it=>{ if(it.id!==itemId) return it; const nit={...it,...patch}; persistItem(nit); return nit; }));
  },[]);
  const toggleDone = useCallback((itemId)=>{
    setItems(is=>is.map(it=>{
      if(it.id!==itemId) return it;
      const nit = (!it.done && it.repeat && it.repeat.freq!=="none")
        ? {...it, date:nextOccur(it.date,it.repeat), done:false}   // 繰り返しは次回へ送る
        : {...it, done:!it.done};
      persistItem(nit); return nit;
    }));
  },[]);
  const addItem = (boxId)=>{ const nit=mkItem({box_id:boxId}); persistItem(nit); setItems(is=>[...is,nit]); };
  const delItem = (itemId)=>{ removeItemDb(itemId); setItems(is=>is.filter(it=>it.id!==itemId)); };
  const moveItem = (itemId, targetBoxId)=>{ patchItem(itemId,{box_id:targetBoxId}); setMoveOpen(null); };

  // ---- 箱操作 ----
  const patchBox=(boxId,patch)=>setBoxes(bs=>bs.map(b=>b.id!==boxId?b:{...b,...patch}));         // ローカルのみ(ドラッグ中)
  const patchBoxP=(boxId,patch)=>setBoxes(bs=>bs.map(b=>{ if(b.id!==boxId) return b; const nb={...b,...patch}; persistBox(nb); return nb; })); // 確定操作
  const addBox=()=>{ const hue=HUES[boxes.length%HUES.length]; const nx=-view.x/view.scale+80, ny=-view.y/view.scale+80;
    const nb={id:uid(),title:"新しいプロジェクト",x:nx,y:ny,w:280,h:null,collapsed:false,hue,type:"project",body:""}; persistBox(nb); setBoxes(bs=>[...bs,nb]); };
  const addNote=()=>{ const nx=-view.x/view.scale+100, ny=-view.y/view.scale+100;
    const nb={id:uid(),title:"メモ",x:nx,y:ny,w:240,h:null,collapsed:false,hue:48,type:"note",body:""}; persistBox(nb); setBoxes(bs=>[...bs,nb]); };
  const delBox=(boxId)=>{
    removeBoxDb(boxId);
    setBoxes(bs=>bs.filter(b=>b.id!==boxId));
    // 箱削除時、所属タスクはInboxへ戻す (DB側は on delete set null と一致させる)
    setItems(is=>is.map(it=>it.box_id===boxId?{...it,box_id:null}:it));
  };

  // ---- 抽出ビュー: Inbox(未分類) と 鏡(重要/今日/今週/今月/それ以降) ----
  const inboxItems = useMemo(()=>items.filter(it=>it.box_id===null && !it.done),[items]);
  const boxTitle = useMemo(()=>{ const m={}; boxes.forEach(b=>{m[b.id]={title:b.title,hue:b.hue};}); return m; },[boxes]);
  const mirror = useMemo(() => {
    const buckets = { star:[], overdue:[], today:[], week:[], month:[], later:[] };
    for(const it of items){
      if(it.done) continue;
      const meta = it.box_id ? boxTitle[it.box_id] : null;
      const ref = { item:it, boxTitle: meta?meta.title:"Inbox", hue: meta?meta.hue:265 };
      if(it.starred){ buckets.star.push(ref); continue; }  // ★は排他で最優先
      if(!it.date) continue;
      const bk = bucketOf(it.date); if(!bk) continue;
      buckets[bk].push(ref);
    }
    const byDate=(a,b)=>{ const da=parseDate(a.item.date), db=parseDate(b.item.date);
      if(!da&&!db) return 0; if(!da) return 1; if(!db) return -1; return da-db; };
    for(const k of Object.keys(buckets)) buckets[k].sort(byDate);
    return buckets;
  }, [items, boxTitle]);

  // ---- キャンバス操作 ----
  const fitToView = useCallback(()=>{
    if(!boxes.length||!canvasRef.current){ setView({x:0,y:0,scale:1}); return; }
    const pad=60;
    const rects=boxes.map(b=>{ const el=boxRefs.current[b.id]; const h=el?el.offsetHeight:(b.collapsed?44:120);
      return {x:b.x,y:b.y,w:b.w||280,h}; });
    const minX=Math.min(...rects.map(r=>r.x))-pad, minY=Math.min(...rects.map(r=>r.y))-pad;
    const maxX=Math.max(...rects.map(r=>r.x+r.w))+pad, maxY=Math.max(...rects.map(r=>r.y+r.h))+pad;
    const cw=canvasRef.current.clientWidth, ch=canvasRef.current.clientHeight;
    const scale=Math.min(cw/(maxX-minX),ch/(maxY-minY),1.2);
    setView({x:-minX*scale+(cw-(maxX-minX)*scale)/2,y:-minY*scale+(ch-(maxY-minY)*scale)/2,scale});
  },[boxes]);
  const onBoxDown=(e,boxId)=>{ if(focusId)return; e.stopPropagation();
    const b=boxes.find(x=>x.id===boxId); drag.current={type:"box",boxId,sx:e.clientX,sy:e.clientY,ox:b.x,oy:b.y}; bindMove(); };
  const onResizeDown=(e,boxId)=>{ e.stopPropagation();
    const b=boxes.find(x=>x.id===boxId); const el=boxRefs.current[boxId];
    const oh = b.h!=null ? b.h : (el?el.offsetHeight:160);
    drag.current={type:"resize",boxId,sx:e.clientX,sy:e.clientY,ow:b.w||280,oh}; bindMove(); };
  const onCanvasDown=()=>{ if(focusId)return; drag.current={type:"pan",sx:null,sy:null,ox:view.x,oy:view.y}; bindMove(); };
  const bindMove=()=>{ window.addEventListener("pointermove",onMove); window.addEventListener("pointerup",onUp); };
  const onMove=useCallback((e)=>{
    const d=drag.current; if(!d) return; const s=viewRef.current.scale;
    if(d.type==="box") patchBox(d.boxId,{x:d.ox+(e.clientX-d.sx)/s,y:d.oy+(e.clientY-d.sy)/s});
    else if(d.type==="resize") patchBox(d.boxId,{ w:Math.max(220,d.ow+(e.clientX-d.sx)/s), h:Math.max(90,d.oh+(e.clientY-d.sy)/s) });
    else if(d.type==="pan"){ if(d.sx===null){d.sx=e.clientX;d.sy=e.clientY;return;} setView(v=>({...v,x:d.ox+(e.clientX-d.sx),y:d.oy+(e.clientY-d.sy)})); }
  },[]);
  const onUp=useCallback(()=>{
    const d=drag.current;
    if(d && (d.type==="box"||d.type==="resize")){
      setBoxes(bs=>{ const b=bs.find(x=>x.id===d.boxId); if(b) persistBox(b); return bs; }); // 確定時のみDB書込
    }
    drag.current=null; window.removeEventListener("pointermove",onMove); window.removeEventListener("pointerup",onUp);
  },[onMove]);
  const onWheel=(e)=>{ if(focusId)return; const delta=-e.deltaY*0.0012;
    setView(v=>{ const ns=Math.min(2,Math.max(0.3,v.scale*(1+delta))); const rect=canvasRef.current.getBoundingClientRect();
      const mx=e.clientX-rect.left,my=e.clientY-rect.top; return {scale:ns,x:mx-(mx-v.x)*(ns/v.scale),y:my-(my-v.y)*(ns/v.scale)}; }); };

  const focusBox = focusId ? boxes.find(b=>b.id===focusId) : null;
  const projects = boxes.filter(b=>b.type==="project");
  const itemsOf = (boxId)=>items.filter(it=>it.box_id===boxId);
  // タスク行に渡す共通ハンドラ束
  const H = (boxId)=>({
    onToggle:(iid)=>toggleDone(iid),
    onItem:(iid,p)=>patchItem(iid,p),
    onAddItem:()=>addItem(boxId),
    onDelItem:(iid)=>delItem(iid),
    onMove:(iid,target)=>moveItem(iid,target),
    moveOpen, setMoveOpen, dateOpen, setDateOpen, openDetail, setOpenDetail, projects,
  });

  if(loading) return <Centered>読み込み中…</Centered>;
  if(!session) return <Login />;

  // ============ スマホレイアウト ============
  if(isMobile){
    return (
      <div style={{...S.root, "--fs": fontScale}}>
        <div style={{...S.toolbar, flexWrap:"wrap", gap:6}}>
          <span style={{...S.brand, fontSize:"calc(16px * var(--fs))"}}>空間ボード</span>
          <div style={{flex:1}} />
          <div style={S.fsCtrl}>
            <button style={S.fsBtn} onClick={()=>bumpFont(-0.1)}>A−</button>
            <button style={S.fsBtn} onClick={()=>bumpFont(0.1)}>A＋</button>
          </div>
          <button style={S.btnGhost} onClick={()=>supabase.auth.signOut()}>ログアウト</button>
          <div style={S.viewToggle}>
            <button style={{...S.vtBtn, ...(mobileView==="now"?S.vtOn:{})}} onClick={()=>setMobileView("now")}>今やること</button>
            <button style={{...S.vtBtn, ...(mobileView==="all"?S.vtOn:{})}} onClick={()=>setMobileView("all")}>全体</button>
          </div>
        </div>
        <div style={S.mBody}>
          {mobileView==="now" ? (
            <>
              <InboxPanel items={inboxItems} h={H(null)} />
              <MirrorSection title="★ 重要" refs={mirror.star} empty="なし" h={H(null)} accent="#b8860b" />
          <MirrorSection title="期限切れ" refs={mirror.overdue} empty="なし" h={H(null)} accent="#8f1d1d" />
              <MirrorSection title="今日" refs={mirror.today} empty="なし" h={H(null)} accent="#c0392b" />
              <MirrorSection title="今週" refs={mirror.week} empty="なし" h={H(null)} accent="#c77d1a" />
            </>
          ) : (
            <>
              <InboxPanel items={inboxItems} h={H(null)} />
              {boxes.map(b=> b.type==="note" ? (
                <div key={b.id} style={{...S.mCard, background:`hsl(${b.hue} 78% 95%)`, borderColor:`hsl(${b.hue} 45% 78%)`}}>
                  <div style={S.mCardHead}>
                    <span style={{...S.dot,background:`hsl(${b.hue} 60% 50%)`}} />
                    <input style={S.titleInput} value={b.title} onChange={(e)=>patchBoxP(b.id,{title:e.target.value})} />
                    <button style={S.iconBtn} onClick={()=>delBox(b.id)}>✕</button>
                  </div>
                  <div style={{padding:"8px"}}>
                    <textarea style={S.noteBody} value={b.body} rows={3} placeholder="メモ… URL可" onChange={(e)=>patchBoxP(b.id,{body:e.target.value})} />
                    <LinkPreview text={b.body} flush />
                  </div>
                </div>
              ) : (
                <div key={b.id} style={{...S.mCard, borderColor:`hsl(${b.hue} 45% 78%)`}}>
                  <div style={{...S.mCardHead, background:`hsl(${b.hue} 60% 92%)`}}>
                    <span style={{...S.dot,background:`hsl(${b.hue} 60% 50%)`}} />
                    <input style={S.titleInput} value={b.title} onChange={(e)=>patchBoxP(b.id,{title:e.target.value})} />
                    <button style={S.iconBtn} onClick={()=>delBox(b.id)}>✕</button>
                  </div>
                  <ItemList items={itemsOf(b.id)} h={H(b.id)} />
                </div>
              ))}
              <button style={{...S.btn, width:"100%", marginTop:8}} onClick={addBox}>＋ プロジェクト</button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ============ PCレイアウト (空間ボード + サイドパネル) ============
  return (
    <div style={{...S.root, "--fs": fontScale}}>
      <div style={S.toolbar}>
        <span style={S.brand}>空間ボード</span>
        <div style={{flex:1}} />
        <div style={S.fsCtrl} title="文字サイズ">
          <button style={S.fsBtn} onClick={()=>bumpFont(-0.1)}>A−</button>
          <span style={S.fsVal}>{Math.round(fontScale*100)}%</span>
          <button style={S.fsBtn} onClick={()=>bumpFont(0.1)}>A＋</button>
          {fontScale!==1 && <button style={S.fsReset} onClick={()=>setFontScale(1)}>リセット</button>}
        </div>
        <button style={S.btn} onClick={addBox}>＋ プロジェクト</button>
        <button style={S.btn} onClick={addNote}>＋ 付箋</button>
        <button style={S.btn} onClick={fitToView}>⤢ 全体を見る</button>
        <button style={S.btnGhost} onClick={()=>supabase.auth.signOut()}>ログアウト</button>
      </div>
      <div style={S.body}>
        <div ref={canvasRef} style={S.canvas} onPointerDown={onCanvasDown} onWheel={onWheel}>
          <div style={{position:"absolute",transformOrigin:"0 0",transform:`translate(${view.x}px,${view.y}px) scale(${view.scale})`}}>
            {boxes.map(b=>(
              <Box key={b.id} b={b} items={itemsOf(b.id)} refCb={(el)=>{boxRefs.current[b.id]=el;}}
                onDown={onBoxDown} onResizeDown={onResizeDown}
                onCollapse={()=>patchBoxP(b.id,{collapsed:!b.collapsed})}
                onFocus={()=>setFocusId(b.id)} onDelBox={()=>delBox(b.id)}
                onTitle={(t)=>patchBoxP(b.id,{title:t})}
                onBody={(t)=>patchBoxP(b.id,{body:t})}
                noteOpen={noteOpenFor===b.id}
                onToggleNote={()=>setNoteOpenFor(noteOpenFor===b.id?null:b.id)}
                onPalette={()=>setPaletteFor(paletteFor===b.id?null:b.id)} paletteOpen={paletteFor===b.id}
                onPickHue={(h)=>{patchBoxP(b.id,{hue:h});setPaletteFor(null);}}
                onAutoH={()=>patchBoxP(b.id,{h:null})}
                h={H(b.id)} />
            ))}
          </div>
          <div style={S.hint}>背景ドラッグ=移動 / ホイール=ズーム / 右下=サイズ変更 / 右下ダブルクリック=高さ自動</div>
        </div>
        <aside style={S.side}>
          <MirrorSection title="★ 重要" refs={mirror.star} empty="なし" h={H(null)} accent="#b8860b" />
          <MirrorSection title="期限切れ" refs={mirror.overdue} empty="なし" h={H(null)} accent="#8f1d1d" />
          <MirrorSection title="今日" refs={mirror.today} empty="なし" h={H(null)} accent="#c0392b" />
          <MirrorSection title="今週" refs={mirror.week} empty="なし" h={H(null)} accent="#c77d1a" />
          <MirrorSection title="今月" refs={mirror.month} empty="なし" h={H(null)} accent="#2c7a5b" />
          <MirrorSection title="それ以降" refs={mirror.later} empty="なし" h={H(null)} accent="#5566aa" />
          <InboxPanel items={inboxItems} h={H(null)} />
        </aside>
      </div>
      {focusBox && (
        <div style={S.overlay} onPointerDown={()=>setFocusId(null)}>
          <div style={S.focusCard} onPointerDown={(e)=>e.stopPropagation()}>
            <div style={{...S.boxHead,background:`hsl(${focusBox.hue} 60% 92%)`,borderColor:`hsl(${focusBox.hue} 45% 80%)`}}>
              <span style={{...S.dot,background:`hsl(${focusBox.hue} 60% 50%)`}} />
              <input style={S.titleInput} value={focusBox.title} onChange={(e)=>patchBoxP(focusBox.id,{title:e.target.value})} />
              <button style={S.iconBtn} onClick={()=>setFocusId(null)}>✕</button>
            </div>
            <ItemList items={itemsOf(focusBox.id)} big h={H(focusBox.id)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- キャンバス上の箱 (プロジェクト / 付箋) ----
function Box({ b, items, refCb, onDown, onResizeDown, onCollapse, onFocus, onDelBox, onTitle, onBody, noteOpen, onToggleNote, onPalette, paletteOpen, onPickHue, onAutoH, h }) {
  const isNote = b.type==="note";
  const bodyStyle = b.h!=null ? { minHeight:Math.max(0,b.h-44) } : {}; // h=最低高さ。内容が増えれば自動で伸びる
  const boxBg = isNote ? { background:`hsl(${b.hue} 78% 95%)` } : {};
  return (
    <div ref={refCb} style={{...S.box,left:b.x,top:b.y,width:b.w||280,borderColor:`hsl(${b.hue} 45% 78%)`,...boxBg}}>
      <div style={{...S.boxHead,background:`hsl(${b.hue} 60% 92%)`,borderColor:`hsl(${b.hue} 45% 80%)`}} onPointerDown={(e)=>onDown(e,b.id)}>
        <span style={{...S.dot,background:`hsl(${b.hue} 60% 50%)`,cursor:"pointer"}} onPointerDown={(e)=>{e.stopPropagation();onPalette();}} title="色を変える" />
        <input style={S.titleInput} value={b.title} onPointerDown={(e)=>e.stopPropagation()} onChange={(e)=>onTitle(e.target.value)} />
        {!isNote && <button style={{...S.iconBtn,color:b.body?"#5a8dd6":"#6a6a62"}} title="プロジェクト全体メモ" onPointerDown={(e)=>e.stopPropagation()} onClick={onToggleNote}>≡</button>}
        {!isNote && <button style={S.iconBtn} title="折りたたむ" onPointerDown={(e)=>e.stopPropagation()} onClick={onCollapse}>{b.collapsed?"▸":"▾"}</button>}
        {!isNote && <button style={S.iconBtn} title="フォーカス" onPointerDown={(e)=>e.stopPropagation()} onClick={onFocus}>⤢</button>}
        <button style={S.iconBtn} title="削除" onPointerDown={(e)=>e.stopPropagation()} onClick={onDelBox}>✕</button>
      </div>
      {paletteOpen && (
        <div style={S.palette} onPointerDown={(e)=>e.stopPropagation()}>
          {PALETTE.map(hh=>(<button key={hh} onClick={()=>onPickHue(hh)} style={{...S.swatch,background:`hsl(${hh} 60% 50%)`,outline:b.hue===hh?"2px solid #333":"none"}} />))}
        </div>
      )}
      {isNote ? (
        <div style={{padding:"8px"}} onPointerDown={(e)=>e.stopPropagation()}>
          <textarea style={S.noteBody} value={b.body} placeholder="メモ… URLを貼るとリンクになる" rows={4} onChange={(e)=>onBody(e.target.value)} />
          <LinkPreview text={b.body} flush />
        </div>
      ) : (
        <>
          {noteOpen && (
            <div style={S.projNote} onPointerDown={(e)=>e.stopPropagation()}>
              <textarea style={S.noteBody} value={b.body} placeholder="プロジェクト全体メモ… URL可" rows={3} onChange={(e)=>onBody(e.target.value)} />
              <LinkPreview text={b.body} flush />
            </div>
          )}
          {!b.collapsed && <div style={bodyStyle}><ItemList items={items} h={h} /></div>}
        </>
      )}
      {!b.collapsed && (
        <div style={S.resizeHandle} onPointerDown={(e)=>onResizeDown(e,b.id)} onDoubleClick={(e)=>{e.stopPropagation();onAutoH();}} title="ドラッグ=サイズ変更 / ダブルクリック=高さ自動">⌟</div>
      )}
    </div>
  );
}

// ---- 移動先ポップ (Inbox + プロジェクト一覧) ----
function MovePop({ item, h }) {
  return (
    <div style={S.movePop} onPointerDown={(e)=>e.stopPropagation()}>
      <div style={S.moveLabel}>移動先</div>
      <button style={{...S.moveBtn, ...(item.box_id===null?S.moveCur:{})}} disabled={item.box_id===null}
        onClick={()=>h.onMove(item.id,null)}>📥 Inbox</button>
      {h.projects.map(p=>(
        <button key={p.id} style={{...S.moveBtn, ...(p.id===item.box_id?S.moveCur:{})}} disabled={p.id===item.box_id}
          onClick={()=>h.onMove(item.id,p.id)}>
          <span style={{...S.mirrorDot,background:`hsl(${p.hue} 60% 50%)`,display:"inline-block",marginRight:6}} />{p.title||"(無題)"}
        </button>
      ))}
    </div>
  );
}

// ---- 浮遊ポップ土台: 箱のoverflowにクリップされないfixed配置 + 画面端クランプ + 背景クリックで閉じる ----
function PopOverlay({ pos, width, onClose, children }){
  const left = Math.max(8, Math.min(pos.x, window.innerWidth - width - 12));
  const top = Math.max(8, Math.min(pos.y, window.innerHeight - 400));
  return (
    <div style={S.popBack} onPointerDown={(e)=>{e.stopPropagation(); onClose();}}>
      <div style={{position:"fixed", left, top, zIndex:51}} onPointerDown={(e)=>e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ---- 月曜始まりカレンダー (標準ピッカーはOSロケール依存で週開始を変えられないため自前実装) ----
function CalPop({ value, onPick, onClear }){
  const init = parseDate(value) || now0();
  const [ym,setYm] = useState({ y:init.getFullYear(), m:init.getMonth() });
  const first = new Date(ym.y, ym.m, 1);
  const offset = (first.getDay()+6)%7;             // 月曜=0
  const daysIn = new Date(ym.y, ym.m+1, 0).getDate();
  const cells = []; for(let i=0;i<offset;i++) cells.push(null); for(let d=1;d<=daysIn;d++) cells.push(d);
  const sel = parseDate(value); const today = now0();
  return (
    <div style={S.calPop} onPointerDown={(e)=>e.stopPropagation()}>
      <div style={S.calHead}>
        <button style={S.calNav} onClick={()=>setYm(p=>p.m===0?{y:p.y-1,m:11}:{y:p.y,m:p.m-1})}>‹</button>
        <span style={S.calTitle}>{ym.y}年{ym.m+1}月</span>
        <button style={S.calNav} onClick={()=>setYm(p=>p.m===11?{y:p.y+1,m:0}:{y:p.y,m:p.m+1})}>›</button>
      </div>
      <div style={S.calGrid}>
        {["月","火","水","木","金","土","日"].map(w=><div key={w} style={S.calWd}>{w}</div>)}
        {cells.map((d,i)=>{
          if(d===null) return <div key={"e"+i} />;
          const dt = new Date(ym.y, ym.m, d);
          const isSel = sel && +dt===+sel, isTd = +dt===+today;
          return (
            <button key={i} style={{...S.calDay,...(isTd?S.calToday:{}),...(isSel?S.calSel:{})}}
              onClick={()=>onPick(toStr(dt))}>{d}</button>
          );
        })}
      </div>
      <div style={{display:"flex",gap:6,marginTop:8}}>
        <button style={S.calQuick} onClick={()=>onPick(toStr(today))}>今日</button>
        <button style={S.calQuick} onClick={onClear}>クリア</button>
      </div>
    </div>
  );
}

// ---- 項目リスト (箱内 / Inbox / スマホ共通) ----
function ItemList({ items, big, h }) {
  return (
    <div style={{padding:"6px 8px 8px"}}>
      {items.map(it=>{
        const open = h.openDetail===it.id;
        const mOpen = h.moveOpen && h.moveOpen.id===it.id;
        const dOpen = h.dateOpen && h.dateOpen.id===it.id;
        const rsum = summarizeRepeat(it.repeat);
        return (
          <div key={it.id} style={S.itemWrap}>
            <div style={S.item}>
              <input type="checkbox" checked={it.done} onChange={()=>h.onToggle(it.id)} style={S.check} />
              <button style={{...S.starBtn,color:it.starred?"#d4a017":"#c8c8be"}} title="重要"
                onPointerDown={(e)=>e.stopPropagation()} onClick={()=>h.onItem(it.id,{starred:!it.starred})}>{it.starred?"★":"☆"}</button>
              <input style={{...S.itemText,...(it.done?S.done:{}),...(big?{fontSize:"calc(18px * var(--fs))"}:{})}} value={it.text} placeholder="タスクを入力"
                onPointerDown={(e)=>e.stopPropagation()} onChange={(e)=>h.onItem(it.id,{text:e.target.value})} />
              <button style={S.iconBtn} onPointerDown={(e)=>e.stopPropagation()} onClick={()=>h.onDelItem(it.id)}>✕</button>
            </div>
            <div style={S.item2}>
              <input style={S.memoLine2} value={it.memo} placeholder="+ 一行メモ" onPointerDown={(e)=>e.stopPropagation()} onChange={(e)=>h.onItem(it.id,{memo:e.target.value})} />
              <button style={{...S.dateBtn,...(it.date?{}:S.dateBtnEmpty)}} title="日付(月曜始まり)"
                onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>{const r=e.currentTarget.getBoundingClientRect();h.setDateOpen(dOpen?null:{id:it.id,x:r.left,y:r.bottom+4});}}>{it.date?fmtShort(it.date):"📅 日付"}</button>
              <button style={{...S.iconBtn,color:mOpen?"#35608f":"#8a8a80"}} title="プロジェクト間を移動"
                onPointerDown={(e)=>e.stopPropagation()} onClick={(e)=>{const r=e.currentTarget.getBoundingClientRect();h.setMoveOpen(mOpen?null:{id:it.id,x:r.left,y:r.bottom+4});}}>⇄</button>
              <button style={{...S.iconBtn,color:it.detail?"#5a8dd6":"#c8c8be"}} title="メモを開く"
                onPointerDown={(e)=>e.stopPropagation()} onClick={()=>h.setOpenDetail(open?null:it.id)}>▤</button>
            </div>
            {dOpen && <PopOverlay pos={h.dateOpen} width={256} onClose={()=>h.setDateOpen(null)}><CalPop value={it.date} onPick={(s)=>{h.onItem(it.id,{date:s});h.setDateOpen(null);}} onClear={()=>{h.onItem(it.id,{date:""});h.setDateOpen(null);}} /></PopOverlay>}
            {mOpen && <PopOverlay pos={h.moveOpen} width={240} onClose={()=>h.setMoveOpen(null)}><MovePop item={it} h={h} /></PopOverlay>}
            <LinkPreview text={it.memo} />
            {rsum && <span style={S.repeatTag}>{rsum}</span>}
            {open && (
              <div style={S.detailWrap} onPointerDown={(e)=>e.stopPropagation()}>
                <textarea style={S.detailArea} value={it.detail} placeholder="詳細メモ(複数行) / URLを貼るとリンクになる" rows={4} onChange={(e)=>h.onItem(it.id,{detail:e.target.value})} />
                <LinkPreview text={it.detail} flush />
                <RepeatEditor repeat={it.repeat} onChange={(r)=>h.onItem(it.id,{repeat:r})} />
              </div>
            )}
          </div>
        );
      })}
      <button style={S.addItem} onPointerDown={(e)=>e.stopPropagation()} onClick={h.onAddItem}>＋ 項目</button>
    </div>
  );
}

// ---- Inbox (仮想ビュー: box_id=null の未完了タスクが自動で集まる) ----
function InboxPanel({ items, h }) {
  return (
    <div style={S.mirrorBlock}>
      <div style={{...S.mirrorHead,color:"#8a4fb8",borderColor:"#8a4fb8"}}>📥 Inbox <span style={{opacity:.55}}>({items.length})</span></div>
      <ItemList items={items} h={h} />
    </div>
  );
}

// ---- Todoist風の繰り返し設定 ----
function RepeatEditor({ repeat, onChange }) {
  const r = repeat || emptyRepeat();
  const set = (patch)=>onChange({...r,...patch});
  const toggleWd = (d)=>{ const s=new Set(r.weekdays||[]); s.has(d)?s.delete(d):s.add(d); set({weekdays:[...s].sort()}); };
  return (
    <div style={S.repEditor}>
      <div style={S.repLabel}>繰り返し</div>
      <div style={S.repFreqRow}>
        {[["none","なし"],["daily","毎日"],["weekly","毎週"],["monthly","毎月"],["yearly","毎年"]].map(([v,l])=>(
          <button key={v} onClick={()=>set({freq:v})} style={{...S.repChip,...(r.freq===v?S.repChipOn:{})}}>{l}</button>
        ))}
      </div>
      {r.freq!=="none" && (
        <div style={S.repDetail}>
          <span style={{fontSize:"calc(12px * var(--fs))",color:"#565049"}}>間隔</span>
          <input type="number" min={1} value={r.interval} style={S.repInterval} onChange={(e)=>set({interval:Math.max(1,+e.target.value||1)})} />
          <span style={{fontSize:"calc(12px * var(--fs))",color:"#565049"}}>{ {daily:"日",weekly:"週",monthly:"ヶ月",yearly:"年"}[r.freq] }ごと</span>
        </div>
      )}
      {r.freq==="weekly" && (
        <div style={S.wdRow}>
          {WD_JP.map((w,i)=>(
            <button key={i} onClick={()=>toggleWd(i)} style={{...S.wdChip,...((r.weekdays||[]).includes(i)?S.wdChipOn:{})}}>{w}</button>
          ))}
          <button onClick={()=>set({weekdays:[1,2,3,4,5]})} style={S.wdPreset}>平日</button>
        </div>
      )}
      {r.freq!=="none" && <div style={S.repPreview}>{summarizeRepeat(r)}</div>}
    </div>
  );
}

// ---- サイドパネルの縮約セクション (鏡: 参照表示) ----
function MirrorSection({ title, refs, empty, h, accent }) {
  return (
    <div style={S.mirrorBlock}>
      <div style={{...S.mirrorHead,color:accent,borderColor:accent}}>{title} <span style={{opacity:.55}}>({refs.length})</span></div>
      {refs.length===0 && <div style={S.mirrorEmpty}>{empty}</div>}
      {refs.map(r=>{
        const mOpen = h.moveOpen && h.moveOpen.id===r.item.id;
        return (
          <div key={r.item.id}>
            <div style={S.mirrorItem}>
              <input type="checkbox" checked={r.item.done} onChange={()=>h.onToggle(r.item.id)} style={S.check} />
              <button style={{...S.starBtn,color:r.item.starred?"#d4a017":"#cfcfc5",marginTop:1}}
                onClick={()=>h.onItem(r.item.id,{starred:!r.item.starred})} title="重要">{r.item.starred?"★":"☆"}</button>
              <div style={{flex:1,minWidth:0}}>
                <div style={S.mirrorText}>{r.item.text||"(無題)"} {summarizeRepeat(r.item.repeat) && <span style={S.mirrorRep}>{summarizeRepeat(r.item.repeat)}</span>}</div>
                {r.item.memo && <div style={S.mirrorMemo}>{r.item.memo}</div>}
                <div style={S.mirrorMeta}><span style={{...S.mirrorDot,background:`hsl(${r.hue} 60% 50%)`}} />{r.boxTitle}{r.item.date?" · "+fmtShort(r.item.date):""}</div>
              </div>
              <button style={{...S.iconBtn,color:mOpen?"#35608f":"#8a8a80"}} title="移動"
                onClick={(e)=>{const rc=e.currentTarget.getBoundingClientRect();h.setMoveOpen(mOpen?null:{id:r.item.id,x:rc.left,y:rc.bottom+4});}}>⇄</button>
            </div>
            {mOpen && <PopOverlay pos={h.moveOpen} width={240} onClose={()=>h.setMoveOpen(null)}><MovePop item={r.item} h={h} /></PopOverlay>}
          </div>
        );
      })}
    </div>
  );
}

function LinkPreview({ text, flush }){
  const urls = extractUrls(text);
  if(urls.length===0) return null;
  return (
    <div style={{...S.linkWrap, ...(flush?{marginLeft:0}:{})}}>
      {urls.map((u,i)=>(
        <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={S.linkChip}
          onPointerDown={(e)=>e.stopPropagation()} title={u}>🔗 {shortUrl(u)}</a>
      ))}
    </div>
  );
}

function Centered({ children }){
  return <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"-apple-system,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif",color:"#565049",fontSize:16,background:"#f7f7f4"}}>{children}</div>;
}

// マジックリンク認証
function Login(){
  const [email,setEmail]=useState("");
  const [sent,setSent]=useState(false);
  const [err,setErr]=useState("");
  const send=async()=>{
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo: window.location.origin } });
    if(error) setErr(error.message); else setSent(true);
  };
  return (
    <Centered>
      <div style={{width:340,maxWidth:"90vw",background:"#fff",border:"1px solid #e3e3dd",borderRadius:12,padding:24,boxShadow:"0 6px 24px rgba(0,0,0,.06)"}}>
        <div style={{fontSize:19,fontWeight:800,marginBottom:6,color:"#1d1d1b"}}>空間ボード</div>
        <div style={{fontSize:13.5,color:"#565049",marginBottom:16,lineHeight:1.5}}>登録済みのメールにログインリンクを送ります。</div>
        {sent ? (
          <div style={{fontSize:14,color:"#2c7a5b",fontWeight:600,lineHeight:1.6}}>メールを確認してください。<br/>リンクを開くとログインします。</div>
        ) : (
          <>
            <input type="email" value={email} placeholder="you@example.com" onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&email&&send()}
              style={{width:"100%",boxSizing:"border-box",border:"1px solid #dcdcd3",borderRadius:8,padding:"10px 12px",fontSize:15,marginBottom:12,outline:"none"}} />
            <button onClick={send} disabled={!email}
              style={{width:"100%",border:"none",background:email?"#35608f":"#b8b8ae",color:"#fff",borderRadius:8,padding:"11px",fontSize:15,fontWeight:700,cursor:email?"pointer":"default"}}>
              ログインリンクを送信
            </button>
            {err && <div style={{fontSize:12.5,color:"#c0392b",marginTop:10,lineHeight:1.5}}>{err}</div>}
          </>
        )}
      </div>
    </Centered>
  );
}

/* 配色方針: 彩度は抑えたまま明度コントラストを確保。補助テキストは濃いめ+weight500以上。フォントは大きめ。 */
const INK = "#1d1d1b";
const SUB = "#565049";
const FAINT = "#8f887e";
const S = {
  root:{position:"absolute",inset:0,display:"flex",flexDirection:"column",fontFamily:"-apple-system,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif",background:"#f7f7f4",color:INK},
  toolbar:{display:"flex",alignItems:"center",gap:8,padding:"11px 16px",borderBottom:"1px solid #e3e3dd",background:"#fff"},
  brand:{fontWeight:700,letterSpacing:".01em",fontSize:"calc(18px * var(--fs))"},
  btn:{border:"1px solid #cfcfc5",background:"#fff",borderRadius:8,padding:"8px 15px",fontSize:"calc(15px * var(--fs))",fontWeight:600,cursor:"pointer",color:"#2a2a26"},
  btnGhost:{border:"1px solid #e3e3dd",background:"transparent",borderRadius:8,padding:"8px 13px",fontSize:"calc(14px * var(--fs))",fontWeight:600,cursor:"pointer",color:SUB},
  body:{flex:1,display:"flex",minHeight:0},
  canvas:{flex:1,position:"relative",overflow:"hidden",cursor:"grab",background:"radial-gradient(#e4e4dc 1px,transparent 1px)",backgroundSize:"22px 22px"},
  hint:{position:"absolute",left:12,bottom:10,fontSize:"calc(13px * var(--fs))",fontWeight:500,color:SUB,background:"rgba(255,255,255,.82)",padding:"5px 10px",borderRadius:6,pointerEvents:"none"},
  box:{position:"absolute",background:"#fff",borderRadius:10,border:"1px solid",boxShadow:"0 1px 3px rgba(0,0,0,.08),0 6px 16px rgba(0,0,0,.05)"},
  boxHead:{display:"flex",alignItems:"center",gap:7,padding:"9px 9px",borderBottom:"1px solid",borderRadius:"10px 10px 0 0",cursor:"grab"},
  dot:{width:13,height:13,borderRadius:"50%",flexShrink:0},
  titleInput:{flex:1,border:"none",background:"transparent",fontWeight:700,fontSize:"calc(16.5px * var(--fs))",color:INK,outline:"none",minWidth:0},
  iconBtn:{border:"none",background:"transparent",cursor:"pointer",color:"#6a6a62",fontSize:"calc(14px * var(--fs))",padding:"2px 5px",borderRadius:4,lineHeight:1},
  palette:{display:"flex",gap:7,padding:"9px",flexWrap:"wrap",borderBottom:"1px solid #eee",background:"#fafaf7"},
  swatch:{width:26,height:26,borderRadius:"50%",border:"1px solid rgba(0,0,0,.12)",cursor:"pointer"},
  itemWrap:{padding:"5px 0",borderBottom:"1px solid #eeeee7"},
  item:{display:"flex",alignItems:"center",gap:6},
  check:{width:18,height:18,cursor:"pointer",flexShrink:0},
  starBtn:{border:"none",background:"transparent",cursor:"pointer",fontSize:"calc(16px * var(--fs))",padding:"0 1px",lineHeight:1,flexShrink:0},
  itemText:{flex:1,border:"none",background:"transparent",fontSize:"calc(16.5px * var(--fs))",fontWeight:500,outline:"none",padding:"4px 2px",minWidth:0,color:INK},
  done:{textDecoration:"line-through",color:FAINT,fontWeight:400},
  dateInput:{border:"1px solid #dcdcd3",borderRadius:5,fontSize:"calc(13.5px * var(--fs))",fontWeight:600,padding:"4px 5px",color:"#3f3f38",background:"#fafaf7",width:134},
  memoLine:{display:"block",width:"100%",boxSizing:"border-box",border:"none",background:"transparent",fontSize:"calc(14.5px * var(--fs))",fontWeight:500,color:SUB,outline:"none",padding:"3px 2px 4px 25px"},
  repeatTag:{display:"inline-block",fontSize:"calc(13px * var(--fs))",fontWeight:600,color:"#4d4d45",marginLeft:25,background:"#ececE4",padding:"2px 7px",borderRadius:4},
  detailWrap:{margin:"6px 2px 8px 25px",padding:"9px",background:"#fafaf7",border:"1px solid #e6e6de",borderRadius:6},
  detailArea:{width:"100%",boxSizing:"border-box",border:"1px solid #dcdcd3",borderRadius:5,fontSize:"calc(14.5px * var(--fs))",padding:"7px",resize:"vertical",fontFamily:"inherit",color:INK,outline:"none",lineHeight:1.5},
  repEditor:{marginTop:10,paddingTop:9,borderTop:"1px dashed #dcdcd3"},
  repLabel:{fontSize:"calc(13.5px * var(--fs))",fontWeight:600,color:SUB,marginBottom:6},
  repFreqRow:{display:"flex",gap:6,flexWrap:"wrap"},
  repChip:{border:"1px solid #cfcfc5",background:"#fff",borderRadius:6,padding:"5px 12px",fontSize:"calc(14px * var(--fs))",fontWeight:600,cursor:"pointer",color:"#4d4d45"},
  repChipOn:{background:"#35608f",borderColor:"#35608f",color:"#fff"},
  repDetail:{display:"flex",alignItems:"center",gap:7,marginTop:9},
  repInterval:{width:52,border:"1px solid #dcdcd3",borderRadius:5,fontSize:"calc(14px * var(--fs))",padding:"4px 5px",textAlign:"center"},
  wdRow:{display:"flex",gap:5,marginTop:9,flexWrap:"wrap"},
  wdChip:{width:31,height:31,border:"1px solid #cfcfc5",background:"#fff",borderRadius:"50%",fontSize:"calc(14px * var(--fs))",fontWeight:600,cursor:"pointer",color:"#4d4d45",padding:0},
  wdChipOn:{background:"#35608f",borderColor:"#35608f",color:"#fff"},
  wdPreset:{border:"1px solid #cfcfc5",background:"#fff",borderRadius:6,padding:"0 12px",fontSize:"calc(14px * var(--fs))",fontWeight:600,cursor:"pointer",color:"#4d4d45"},
  repPreview:{marginTop:9,fontSize:"calc(14px * var(--fs))",color:"#35608f",fontWeight:700},
  addItem:{marginTop:8,border:"1px dashed #cfcfc5",background:"transparent",width:"100%",borderRadius:6,padding:"6px",fontSize:"calc(14px * var(--fs))",fontWeight:600,color:SUB,cursor:"pointer"},
  resizeHandle:{position:"absolute",right:2,bottom:2,width:18,height:18,cursor:"nwse-resize",color:"#a8a89e",fontSize:14,lineHeight:"16px",textAlign:"right",userSelect:"none"},
  side:{width:350,flexShrink:0,borderLeft:"1px solid #e3e3dd",background:"#fff",overflowY:"auto",padding:"18px 18px 52px"},
  mirrorBlock:{marginBottom:24},
  mirrorHead:{fontSize:"calc(18px * var(--fs))",fontWeight:800,borderLeft:"4px solid",paddingLeft:11,marginBottom:11},
  mirrorEmpty:{fontSize:"calc(14.5px * var(--fs))",fontWeight:500,color:FAINT,padding:"2px 0 2px 14px"},
  mirrorItem:{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0 10px 14px",borderBottom:"1px solid #ededE6"},
  mirrorText:{fontSize:"calc(17px * var(--fs))",fontWeight:600,color:INK,lineHeight:1.4,wordBreak:"break-word"},
  mirrorRep:{fontSize:"calc(13px * var(--fs))",fontWeight:600,color:"#6a6a62"},
  mirrorMemo:{fontSize:"calc(14.5px * var(--fs))",fontWeight:500,color:SUB,marginTop:3,lineHeight:1.4},
  mirrorMeta:{fontSize:"calc(14px * var(--fs))",fontWeight:600,color:SUB,marginTop:5,display:"flex",alignItems:"center",gap:6},
  mirrorDot:{width:10,height:10,borderRadius:"50%",flexShrink:0},
  linkWrap:{display:"flex",flexWrap:"wrap",gap:5,margin:"2px 0 5px 25px"},
  linkChip:{display:"inline-block",fontSize:"calc(12.5px * var(--fs))",fontWeight:600,color:"#2f6bbf",background:"#eef4fc",border:"1px solid #d5e3f5",borderRadius:5,padding:"2px 7px",textDecoration:"none",maxWidth:210,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"},
  movePop:{margin:0,padding:"8px",background:"#fff",border:"1px solid #cfd8e6",borderRadius:8,boxShadow:"0 4px 14px rgba(0,0,0,.10)",display:"flex",flexDirection:"column",gap:4},
  moveLabel:{fontSize:"calc(12.5px * var(--fs))",fontWeight:700,color:SUB,marginBottom:2},
  moveBtn:{border:"1px solid #e0e0d8",background:"#fafaf7",borderRadius:6,padding:"7px 10px",fontSize:"calc(14px * var(--fs))",fontWeight:600,color:"#2a2a26",cursor:"pointer",textAlign:"left"},
  moveCur:{opacity:.45,cursor:"default"},
  popBack:{position:"fixed",inset:0,zIndex:50,background:"transparent"},
  noteBody:{width:"100%",boxSizing:"border-box",border:"none",fontSize:"calc(15px * var(--fs))",padding:"2px",resize:"none",fontFamily:"inherit",color:INK,outline:"none",lineHeight:1.6,background:"transparent"},
  projNote:{padding:"8px 8px 5px",borderBottom:"1px solid #eeeee7",background:"#fbfbf8"},
  item2:{display:"flex",alignItems:"center",gap:6,paddingLeft:25,marginTop:1},
  memoLine2:{flex:1,minWidth:0,border:"none",background:"transparent",fontSize:"calc(14.5px * var(--fs))",fontWeight:500,color:SUB,outline:"none",padding:"2px 2px"},
  dateBtn:{border:"1px solid #dcdcd3",background:"#fafaf7",borderRadius:5,fontSize:"calc(13.5px * var(--fs))",fontWeight:600,padding:"3px 9px",color:"#3f3f38",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0},
  dateBtnEmpty:{color:"#8f887e",fontWeight:500},
  calPop:{margin:0,padding:"10px",background:"#fff",border:"1px solid #cfd8e6",borderRadius:8,boxShadow:"0 4px 14px rgba(0,0,0,.10)",width:256,boxSizing:"border-box"},
  calHead:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6},
  calNav:{border:"1px solid #e0e0d8",background:"#fafaf7",borderRadius:6,width:28,height:26,cursor:"pointer",fontSize:14,color:"#2a2a26",padding:0},
  calTitle:{fontSize:"calc(14px * var(--fs))",fontWeight:700,color:INK},
  calGrid:{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2},
  calWd:{textAlign:"center",fontSize:"calc(12px * var(--fs))",fontWeight:700,color:SUB,padding:"2px 0"},
  calDay:{border:"none",background:"transparent",borderRadius:6,padding:"5px 0",fontSize:"calc(13.5px * var(--fs))",fontWeight:600,color:"#2a2a26",cursor:"pointer",textAlign:"center"},
  calToday:{outline:"1.5px solid #c0392b"},
  calSel:{background:"#35608f",color:"#fff"},
  calQuick:{border:"1px solid #cfcfc5",background:"#fff",borderRadius:6,padding:"4px 10px",fontSize:"calc(13px * var(--fs))",fontWeight:600,color:"#4d4d45",cursor:"pointer"},
  overlay:{position:"absolute",inset:0,background:"rgba(30,30,26,.35)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:20},
  focusCard:{width:"min(600px,92vw)",maxHeight:"80vh",overflow:"auto",background:"#fff",borderRadius:12,boxShadow:"0 12px 40px rgba(0,0,0,.25)"},
  // 倍率コントロール(倍率非連動・固定サイズ)
  fsCtrl:{display:"flex",alignItems:"center",gap:6,marginRight:4,padding:"3px 6px",border:"1px solid #e3e3dd",borderRadius:8,background:"#fafaf7"},
  fsBtn:{border:"1px solid #cfcfc5",background:"#fff",borderRadius:6,width:32,height:28,fontSize:14,fontWeight:700,cursor:"pointer",color:"#2a2a26",padding:0},
  fsVal:{fontSize:13,fontWeight:700,color:SUB,minWidth:40,textAlign:"center"},
  fsReset:{border:"none",background:"transparent",fontSize:12,fontWeight:600,color:"#35608f",cursor:"pointer",padding:"0 2px"},
  // スマホ
  mBody:{flex:1,overflowY:"auto",padding:"12px 12px 60px",background:"#f7f7f4"},
  mCard:{background:"#fff",border:"1px solid",borderRadius:10,marginBottom:12,boxShadow:"0 1px 3px rgba(0,0,0,.06)"},
  mCardHead:{display:"flex",alignItems:"center",gap:7,padding:"9px 9px",borderBottom:"1px solid #eeeee7",borderRadius:"10px 10px 0 0"},
  viewToggle:{display:"flex",border:"1px solid #cfcfc5",borderRadius:8,overflow:"hidden",width:"100%"},
  vtBtn:{flex:1,border:"none",background:"#fff",padding:"9px 0",fontSize:"calc(15px * var(--fs))",fontWeight:700,color:SUB,cursor:"pointer"},
  vtOn:{background:"#35608f",color:"#fff"},
};
