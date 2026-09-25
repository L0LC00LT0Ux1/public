const express = require('express');
const multer = require('multer');
const path = require('path');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL_USER = process.env.EMAIL_USER || 'hackroblox.toux1@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'ghoilvnnbnpzslaq';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const ADMIN_NAME = 'T0Ux1';
const COOLDOWN_MS = 5*60*1000;
const DAILY_LIMIT_FREE = 5;
const DAILY_LIMIT_PREMIUM = 15;
const DAILY_DOWNLOAD_LIMIT = 3;

if(!SUPABASE_URL || !SUPABASE_KEY){
  console.error('ต้องตั้งค่า SUPABASE_URL และ SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function isAdminName(n){
  if(!n) return false;
  return String(n).trim().toLowerCase() === ADMIN_NAME.toLowerCase();
}
function isPremiumUser(u){ return !!(u && u.premiumUntil && u.premiumUntil > Date.now()); }
function dayKey(ts){ const d=new Date(ts||Date.now()); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function countToday(arr){ const k=dayKey(); return (arr||[]).filter(x=>dayKey(x)===k).length; }

let transporter = null;
if(EMAIL_USER && EMAIL_PASS){
  transporter = nodemailer.createTransport({service:'gmail', auth:{user:EMAIL_USER, pass:EMAIL_PASS}});
}

app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(__dirname,'public')));

let dbCache = null;
let dbLoaded = false;

async function loadDB(){
  if(dbLoaded && dbCache) return JSON.parse(JSON.stringify(dbCache));
  const { data, error } = await supabase.from('kv').select('*');
  if(error){ console.error('loadDB error:', error.message); return { users:{}, songs:[] }; }
  const db = { users:{}, songs:[] };
  for(const row of data || []){
    if(row.key === 'users') db.users = row.value || {};
    if(row.key === 'songs') db.songs = row.value || [];
  }
  dbCache = JSON.parse(JSON.stringify(db));
  dbLoaded = true;
  return db;
}

async function saveDB(db){
  const { error } = await supabase.from('kv').upsert([
    { key:'users', value: db.users },
    { key:'songs', value: db.songs }
  ]);
  if(error){ console.error('saveDB error:', error.message); return; }
  dbCache = JSON.parse(JSON.stringify(db));
  dbLoaded = true;
}

async function uploadFileToSupabase(file, folder){
  const ext = path.extname(file.originalname || '');
  const filename = Date.now()+'-'+Math.random().toString(36).slice(2,8)+ext;
  const filepath = folder+'/'+filename;
  const { error } = await supabase.storage.from('uploads').upload(filepath, file.buffer, {
    contentType: file.mimetype || 'application/octet-stream',
    upsert: false
  });
  if(error) throw new Error('Upload failed: '+error.message);
  const { data } = supabase.storage.from('uploads').getPublicUrl(filepath);
  return data.publicUrl;
}

async function deleteFileFromSupabase(url){
  if(!url) return;
  try{
    const marker = '/storage/v1/object/public/uploads/';
    const idx = url.indexOf(marker);
    if(idx === -1) return;
    const filepath = url.substring(idx + marker.length);
    await supabase.storage.from('uploads').remove([filepath]);
  }catch(e){ console.error('deleteFile error:', e.message); }
}

const pendingCodes = {};
function genCode(){ return String(Math.floor(100000+Math.random()*900000)); }
async function sendMail(to, subject, html){
  if(!transporter) throw new Error('ยังไม่ได้ตั้งค่าอีเมล');
  await transporter.sendMail({from:'"MyMusic" <'+EMAIL_USER+'>', to, subject, html});
}
function mailTemplate(title, code, sub){
  return '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#000;color:#fff;border-radius:16px">'+
    '<h2 style="margin:0 0 8px">'+title+'</h2>'+
    '<p style="color:#888;margin:0 0 20px">'+sub+'</p>'+
    '<div style="background:#111;border:1px solid #222;border-radius:12px;padding:24px;text-align:center;letter-spacing:8px;font-size:34px;font-weight:800">'+code+'</div>'+
    '<p style="color:#666;font-size:12px;margin:20px 0 0">รหัสนี้หมดอายุใน 10 นาที</p></div>';
}

const upload = multer({ storage: multer.memoryStorage(), limits:{fileSize: 50*1024*1024}});

app.get('/api/users', async (req,res)=>{
  const db = await loadDB(), out = {};
  for(const k in db.users){
    const u = db.users[k];
    out[k] = {
      name:u.name, avatar:u.avatar, followers:u.followers||[], following:u.following||[],
      songs:u.songs||[], liked:u.liked||[], fav:u.fav||[],
      hasEmail: !!(u.email && u.emailVerified),
      isAdmin: isAdminName(k),
      isBanned: !!u.isBanned,
      isPremium: isPremiumUser(u),
      nameColor: u.nameColor || ''
    };
  }
  res.json(out);
});

app.get('/api/me', async (req,res)=>{
  const db = await loadDB();
  const u = db.users[req.query.user];
  if(!u) return res.json({ok:false});
  const admin = isAdminName(req.query.user);
  const prem = isPremiumUser(u);
  const upLimit = admin ? -1 : (prem ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_FREE);
  res.json({
    ok:true, name:u.name, email:u.email||'', emailVerified:!!u.emailVerified,
    isAdmin: admin, isBanned: !!u.isBanned, isPremium: prem,
    premiumUntil: u.premiumUntil||0, nameColor: u.nameColor||'',
    uploadsToday: countToday(u.uploadLog), uploadLimit: upLimit,
    downloadsToday: countToday(u.downloadLog),
    downloadLimit: admin ? -1 : DAILY_DOWNLOAD_LIMIT,
    lastUploadAt: u.lastUploadAt||0,
    cooldownMs: admin ? 0 : COOLDOWN_MS
  });
});

app.post('/api/signup', async (req,res)=>{
  const {name,password} = req.body;
  if(!name||!password) return res.json({ok:false,msg:'กรอกไม่ครบ'});
  const clean = name.trim();
  if(clean.length < 2) return res.json({ok:false,msg:'ชื่อสั้นเกินไป'});
  const db = await loadDB();
  const exists = Object.keys(db.users).some(k=>k.toLowerCase()===clean.toLowerCase());
  if(exists) return res.json({ok:false,msg:'มีชื่อนี้แล้ว'});
  db.users[clean] = {
    name:clean, password, avatar:'', followers:[], following:[],
    liked:[], fav:[], songs:[], email:'', emailVerified:false,
    isBanned:false, premiumUntil:0, nameColor:'',
    uploadLog:[], downloadLog:[], lastUploadAt:0
  };
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/login', async (req,res)=>{
  const {name,password} = req.body;
  const db = await loadDB();
  const key = Object.keys(db.users).find(k=>k.toLowerCase()===(name||'').trim().toLowerCase());
  if(!key || db.users[key].password !== password)
    return res.json({ok:false,msg:'ชื่อหรือรหัสผ่านไม่ถูกต้อง'});
  if(db.users[key].isBanned && !isAdminName(key))
    return res.json({ok:false,msg:'บัญชีนี้ถูกแบน'});
  res.json({ok:true, username:key});
});

app.post('/api/send-verify-email', async (req,res)=>{
  try{
    const {user, email} = req.body;
    if(!user||!email) return res.json({ok:false,msg:'ข้อมูลไม่ครบ'});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ok:false,msg:'อีเมลไม่ถูกต้อง'});
    const db = await loadDB();
    if(!db.users[user]) return res.json({ok:false,msg:'ไม่พบผู้ใช้'});
    for(const k in db.users){
      if(k !== user && db.users[k].email && db.users[k].emailVerified &&
         db.users[k].email.toLowerCase()===email.toLowerCase()){
        return res.json({ok:false,msg:'อีเมลนี้ถูกใช้แล้ว'});
      }
    }
    const code = genCode();
    pendingCodes[email.toLowerCase()] = {code, type:'verify', user, expires:Date.now()+10*60*1000};
    await sendMail(email, 'ยืนยันอีเมล MyMusic', mailTemplate('ยืนยันอีเมล', code, 'รหัสยืนยันบัญชี MyMusic'));
    res.json({ok:true});
  }catch(e){ res.json({ok:false,msg:e.message}); }
});

app.post('/api/verify-email', async (req,res)=>{
  const {user, email, code} = req.body;
  const key = (email||'').toLowerCase();
  const p = pendingCodes[key];
  if(!p) return res.json({ok:false,msg:'ไม่พบรหัส'});
  if(p.expires < Date.now()){ delete pendingCodes[key]; return res.json({ok:false,msg:'รหัสหมดอายุ'}); }
  if(p.type!=='verify' || p.user!==user) return res.json({ok:false,msg:'รหัสไม่ถูกต้อง'});
  if(String(p.code) !== String(code).trim()) return res.json({ok:false,msg:'รหัสไม่ถูกต้อง'});
  const db = await loadDB();
  if(!db.users[user]) return res.json({ok:false,msg:'ไม่พบผู้ใช้'});
  db.users[user].email = email;
  db.users[user].emailVerified = true;
  await saveDB(db);
  delete pendingCodes[key];
  res.json({ok:true});
});

app.post('/api/forgot', async (req,res)=>{
  try{
    const {email} = req.body;
    if(!email) return res.json({ok:false,msg:'กรอกอีเมล'});
    const db = await loadDB();
    let found = null;
    for(const k in db.users){
      const u = db.users[k];
      if(u.email && u.emailVerified && u.email.toLowerCase()===email.toLowerCase()){ found=k; break; }
    }
    if(!found) return res.json({ok:false,msg:'ไม่พบบัญชีที่ใช้อีเมลนี้'});
    const code = genCode();
    pendingCodes[email.toLowerCase()] = {code, type:'reset', user:found, expires:Date.now()+10*60*1000};
    await sendMail(email, 'เข้าสู่ระบบ MyMusic', mailTemplate('เข้าสู่ระบบ', code, 'รหัสเข้าสู่ระบบ MyMusic'));
    res.json({ok:true});
  }catch(e){ res.json({ok:false,msg:e.message}); }
});

app.post('/api/forgot-verify', (req,res)=>{
  const {email, code} = req.body;
  const key = (email||'').toLowerCase();
  const p = pendingCodes[key];
  if(!p) return res.json({ok:false,msg:'ไม่พบรหัส'});
  if(p.expires < Date.now()){ delete pendingCodes[key]; return res.json({ok:false,msg:'รหัสหมดอายุ'}); }
  if(p.type!=='reset') return res.json({ok:false,msg:'รหัสไม่ถูกต้อง'});
  if(String(p.code) !== String(code).trim()) return res.json({ok:false,msg:'รหัสไม่ถูกต้อง'});
  const username = p.user;
  delete pendingCodes[key];
  res.json({ok:true, username});
});

app.get('/api/songs', async (req,res)=>{
  const db = await loadDB();
  res.json(db.songs);
});

app.post('/api/upload',
  upload.fields([{name:'audio',maxCount:1},{name:'cover',maxCount:1},{name:'bg',maxCount:1}]),
  async (req,res)=>{
  try{
    const {title,uploader,volume,description} = req.body;
    if(!title || !req.files.audio) return res.json({ok:false,msg:'ข้อมูลไม่ครบ'});
    const db = await loadDB();
    const user = db.users[uploader];
    if(!user) return res.json({ok:false,msg:'ไม่พบผู้ใช้'});
    if(user.isBanned && !isAdminName(uploader)) return res.json({ok:false,msg:'บัญชีถูกแบน'});

    const admin = isAdminName(uploader);
    const prem = isPremiumUser(user);
    const now = Date.now();

    if(!admin){
      if(user.lastUploadAt && (now - user.lastUploadAt) < COOLDOWN_MS){
        const rem = Math.ceil((COOLDOWN_MS - (now - user.lastUploadAt))/60000);
        return res.json({ok:false, msg:'รออีก '+rem+' นาทีก่อนอัพโหลดเพลงใหม่'});
      }
      const limit = prem ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_FREE;
      if(countToday(user.uploadLog) >= limit){
        return res.json({ok:false, msg:'อัพโหลดครบ '+limit+' เพลงแล้ววันนี้'});
      }
    }

    const audioUrl = await uploadFileToSupabase(req.files.audio[0], 'audio');
    let coverUrl = '';
    let bgUrl = '';
    if(req.files.cover) coverUrl = await uploadFileToSupabase(req.files.cover[0], 'covers');
    if(req.files.bg) bgUrl = await uploadFileToSupabase(req.files.bg[0], 'backgrounds');

    const song = {
      id: Date.now().toString(36)+Math.random().toString(36).slice(2,6),
      title, uploader, description: description||'',
      audioUrl, coverUrl, bgUrl,
      likes:[], volume: parseFloat(volume)||0.5, uploadedAt: now
    };
    db.songs.push(song);
    user.songs = user.songs||[];
    user.songs.push(song.id);
    user.uploadLog = user.uploadLog||[];
    user.uploadLog.push(now);
    user.lastUploadAt = now;
    await saveDB(db);
    res.json({ok:true, song});
  }catch(e){ res.json({ok:false,msg:e.message}); }
});

app.post('/api/edit-song', async (req,res)=>{
  const {songId,user,title,description} = req.body;
  const db = await loadDB();
  const s = db.songs.find(x=>x.id===songId);
  if(!s) return res.json({ok:false,msg:'ไม่พบเพลง'});
  if(s.uploader !== user && !isAdminName(user)) return res.json({ok:false,msg:'ไม่มีสิทธิ์'});
  if(title && title.trim()) s.title = title.trim();
  if(description !== undefined) s.description = description;
  await saveDB(db);
  res.json({ok:true, song:s});
});

app.post('/api/edit-song-media',
  upload.fields([{name:'cover',maxCount:1},{name:'bg',maxCount:1}]),
  async (req,res)=>{
  try{
    const {songId,user} = req.body;
    const db = await loadDB();
    const s = db.songs.find(x=>x.id===songId);
    if(!s) return res.json({ok:false,msg:'ไม่พบเพลง'});
    if(s.uploader !== user && !isAdminName(user)) return res.json({ok:false,msg:'ไม่มีสิทธิ์'});
    if(req.files.cover){
      await deleteFileFromSupabase(s.coverUrl);
      s.coverUrl = await uploadFileToSupabase(req.files.cover[0], 'covers');
    }
    if(req.files.bg){
      await deleteFileFromSupabase(s.bgUrl);
      s.bgUrl = await uploadFileToSupabase(req.files.bg[0], 'backgrounds');
    }
    await saveDB(db);
    res.json({ok:true, song:s});
  }catch(e){ res.json({ok:false,msg:e.message}); }
});

app.post('/api/delete-song', async (req,res)=>{
  const {songId,user} = req.body;
  const db = await loadDB();
  const s = db.songs.find(x=>x.id===songId);
  if(!s) return res.json({ok:false,msg:'ไม่พบเพลง'});
  if(s.uploader !== user && !isAdminName(user)) return res.json({ok:false,msg:'ไม่มีสิทธิ์ลบ'});
  await deleteFileFromSupabase(s.audioUrl);
  await deleteFileFromSupabase(s.coverUrl);
  await deleteFileFromSupabase(s.bgUrl);
  db.songs = db.songs.filter(x=>x.id!==songId);
  for(const k in db.users){
    const u = db.users[k];
    u.songs = (u.songs||[]).filter(id=>id!==songId);
    u.liked = (u.liked||[]).filter(id=>id!==songId);
    u.fav = (u.fav||[]).filter(id=>id!==songId);
  }
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/like', async (req,res)=>{
  const {songId,user} = req.body;
  const db = await loadDB();
  const s = db.songs.find(x=>x.id===songId);
  if(!s) return res.json({ok:false});
  const i = s.likes.indexOf(user);
  if(i>=0) s.likes.splice(i,1); else s.likes.push(user);
  await saveDB(db);
  res.json({ok:true, likes:s.likes});
});

app.post('/api/follow', async (req,res)=>{
  const {from,to} = req.body;
  const db = await loadDB();
  if(!db.users[from]||!db.users[to]) return res.json({ok:false});
  const me = db.users[from], other = db.users[to];
  const i = me.following.indexOf(to);
  if(i>=0){ me.following.splice(i,1); other.followers = other.followers.filter(x=>x!==from); }
  else{ me.following.push(to); other.followers.push(from); }
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/album', async (req,res)=>{
  const {user,songId,type} = req.body;
  const db = await loadDB();
  if(!db.users[user]) return res.json({ok:false});
  const arr = db.users[user][type] = db.users[user][type]||[];
  if(!arr.includes(songId)) arr.push(songId);
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/update', async (req,res)=>{
  const {user,name,avatar,nameColor} = req.body;
  const db = await loadDB();
  const u = db.users[user];
  if(!u) return res.json({ok:false});
  if(name){
    const c = name.trim();
    const dup = Object.keys(db.users).some(k=>k!==user && k.toLowerCase()===c.toLowerCase());
    if(dup) return res.json({ok:false,msg:'ชื่อนี้ถูกใช้แล้ว'});
    u.name = c;
  }
  if(avatar!==undefined) u.avatar = avatar;
  if(nameColor !== undefined && isPremiumUser(u)) u.nameColor = nameColor;
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/download', async (req,res)=>{
  const {user, songId} = req.body;
  const db = await loadDB();
  const u = db.users[user];
  const s = db.songs.find(x=>x.id===songId);
  if(!u || !s) return res.json({ok:false, msg:'ไม่พบข้อมูล'});
  const admin = isAdminName(user);
  if(!admin){
    const cnt = countToday(u.downloadLog);
    if(cnt >= DAILY_DOWNLOAD_LIMIT){
      return res.json({ok:false, msg:'ดาวน์โหลดครบ '+DAILY_DOWNLOAD_LIMIT+' เพลงแล้ววันนี้'});
    }
  }
  u.downloadLog = u.downloadLog||[];
  u.downloadLog.push(Date.now());
  await saveDB(db);
  const remain = admin ? -1 : (DAILY_DOWNLOAD_LIMIT - countToday(u.downloadLog));
  res.json({ok:true, url: s.audioUrl, filename: s.title+'.mp3', remaining: remain});
});

app.post('/api/admin/ban', async (req,res)=>{
  const {admin, target, banned} = req.body;
  if(!isAdminName(admin)) return res.json({ok:false, msg:'ไม่มีสิทธิ์'});
  if(isAdminName(target)) return res.json({ok:false, msg:'แบนแอดมินไม่ได้'});
  const db = await loadDB();
  if(!db.users[target]) return res.json({ok:false, msg:'ไม่พบผู้ใช้'});
  db.users[target].isBanned = !!banned;
  await saveDB(db);
  res.json({ok:true});
});

app.post('/api/admin/premium', async (req,res)=>{
  const {admin, target, days} = req.body;
  if(!isAdminName(admin)) return res.json({ok:false, msg:'ไม่มีสิทธิ์'});
  const db = await loadDB();
  const tu = db.users[target];
  if(!tu) return res.json({ok:false, msg:'ไม่พบผู้ใช้'});
  const d = parseInt(days) || 0;
  if(d > 0){
    const cur = tu.premiumUntil || 0;
    const base = cur > Date.now() ? cur : Date.now();
    tu.premiumUntil = base + d*24*60*60*1000;
  } else {
    tu.premiumUntil = 0;
    tu.nameColor = '';
  }
  await saveDB(db);
  res.json({ok:true, premiumUntil: tu.premiumUntil});
});

app.get('/api/admin/check', (req,res)=>{
  res.json({ok:true, adminName: ADMIN_NAME, supabase: !!supabase});
});

app.listen(PORT,'0.0.0.0',()=>console.log('Server: http://0.0.0.0:'+PORT));
