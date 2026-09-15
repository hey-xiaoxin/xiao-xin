#!/usr/bin/env node
/* eslint-disable */
// AES-256-GCM + PBKDF2 数据加密脚本
// 用法 1：LLM_PASSWORD=xxx node build-data.js
// 用法 2：node build-data.js xxx  (密码直接接参数，不推荐，会留在 shell history)
//
// 输入：data.json（明文，由本地工作台导出）
// 输出：data.enc.json（密文，可推到公开仓库） + data.meta.json（元数据，可推到仓库）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spawnSync = require('child_process').spawnSync;

// 密码：环境变量优先，其次取第一个「非 -- 开头」的参数
const cliArgs = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });
const PASSWORD = process.env.LLM_PASSWORD || cliArgs[0];
// --keep-stamp：沿用已有 data.meta.json 的 _exportedAt（仅重算元数据/指纹时用），
//              避免「内容没变、只是重新打包」被客服端当成「有更新」而弹红
const KEEP_STAMP = process.argv.indexOf('--keep-stamp') >= 0 || process.env.LLM_KEEP_STAMP === '1';
// --new-salt：强制换一把新盐（默认沿用旧盐，保证图片密文可复用、仓库不膨胀）
const NEW_SALT = process.argv.indexOf('--new-salt') >= 0 || process.env.LLM_NEW_SALT === '1';
if (!PASSWORD) {
    console.error('Usage: LLM_PASSWORD=<your_password> node build-data.js [--keep-stamp]');
    console.error('   or: node build-data.js <your_password> [--keep-stamp]');
    process.exit(1);
}
if (PASSWORD.length < 8) {
    console.error('[WARN] 密码少于 8 位，建议使用 12 位以上含字母数字的密码');
}

const here = __dirname;
const dataPath = path.join(here, 'data.json');

// ============================================================================
//  图片外部化：把 llm_qc_v1.media 里的 base64 图片搬出主包
//  · 压成 256 色调色板 PNG（实测 2282KB → 839KB，画质无损观感）
//  · 按「压缩后明文的 sha256」命名 → 内容寻址，内容不变则文件名不变
//  · 单独 AES-256-GCM 加密成 media/<id>.enc（明文哈希做文件名，密文做内容）
//  · 主包里只留 {"__m":id, w, h} 引用
//  收益：主包 3.5MB → 0.4MB；图片天然增量（新增记录只下新增的那张图）
// ============================================================================
const MEDIA_DIR = path.join(here, 'media');
const MEDIA_TMP = path.join(here, 'media_tmp');
const MEDIA_EXT = '.enc';

// 找带 Pillow 的 Python（找不到就降级为「只外置不压缩」，流程不会中断）
function findPython() {
    const cands = [];
    if (process.env.LLM_PYTHON) cands.push(process.env.LLM_PYTHON);
    try {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const base = path.join(home, '.workbuddy', 'binaries', 'python');
        ['envs', 'versions'].forEach(function (sub) {
            const d = path.join(base, sub);
            if (!fs.existsSync(d)) return;
            fs.readdirSync(d).forEach(function (name) {
                cands.push(path.join(d, name, 'Scripts', 'python.exe'));
                cands.push(path.join(d, name, 'bin', 'python3'));
                cands.push(path.join(d, name, 'python.exe'));
            });
        });
    } catch (e) { }
    cands.push('python', 'python3');
    for (let i = 0; i < cands.length; i++) {
        const p = cands[i];
        if (p.indexOf(path.sep) >= 0 && !fs.existsSync(p)) continue;
        try {
            const r = spawnSync(p, ['-c', 'import PIL,sys;sys.stdout.write("ok")'],
                { encoding: 'utf8', timeout: 60000 });
            if (r.status === 0 && String(r.stdout || '').indexOf('ok') >= 0) return p;
        } catch (e) { console.log('[WARN] 探测 ' + p + ' 失败：' + e.message); }
    }
    return null;
}

// 返回 { items: {mediaKey:{id,w,h,s}}, buffers: [{id,buffer}], mode, stats }
function externalizeMedia(dataJson) {
    const empty = { items: {}, buffers: [], mode: 'none', stats: null };
    const qcRaw = dataJson.llm_qc_v1;
    if (!qcRaw) return empty;
    let qc;
    try { qc = (typeof qcRaw === 'string') ? JSON.parse(qcRaw) : qcRaw; }
    catch (e) { console.log('[WARN] llm_qc_v1 解析失败，跳过图片外部化'); return empty; }
    const media = qc.media || {};
    if (!Object.keys(media).length) return empty;

    let items = {}, buffers = [], stats = null, mode = 'js';

    // ---- 优先：Python + Pillow（带 256 色压缩）----
    const py = findPython();
    if (py) {
        try {
            fs.rmSync(MEDIA_TMP, { recursive: true, force: true });
            fs.mkdirSync(MEDIA_TMP, { recursive: true });
            const r = spawnSync(py, [path.join(here, 'externalize-media.py'), dataPath, MEDIA_TMP],
                { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
            if (r.status === 0 && r.stdout) {
                const out = JSON.parse(r.stdout);
                if (out && out.ok && Object.keys(out.items || {}).length) {
                    items = out.items; stats = out.stats; mode = 'pillow';
                    (out.files || []).forEach(function (f) {
                        try { buffers.push({ id: f.id, buffer: fs.readFileSync(f.src) }); } catch (e) { }
                    });
                }
            } else {
                const tail = String(r.stderr || '').trim().split('\n').filter(Boolean).pop() || '无输出';
                console.log('[WARN] externalize-media.py 未成功：' + tail);
            }
        } catch (e) {
            console.log('[WARN] 调用 Python 失败：' + e.message);
        }
    } else {
        console.log('[WARN] 未找到带 Pillow 的 Python → 降级为「只外置不压缩」');
    }

    // ---- 降级：纯 JS 只外置（不压缩）----
    if (!Object.keys(items).length) {
        mode = 'js';
        const seen = {};
        let origB = 0, outB = 0;
        Object.keys(media).forEach(function (k) {
            const v = media[k];
            if (typeof v !== 'string' || v.indexOf('data:') !== 0) return;
            try {
                const buf = Buffer.from(v.slice(v.indexOf(',') + 1), 'base64');
                const id = crypto.createHash('sha256').update(buf).digest().subarray(0, 8).toString('hex');
                let w = 0, h = 0;
                if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && buf.length > 24) {
                    w = buf.readUInt32BE(16); h = buf.readUInt32BE(20);
                }
                items[k] = { id: id, w: w, h: h, s: buf.length };
                if (!seen[id]) { seen[id] = 1; buffers.push({ id: id, buffer: buf }); }
                origB += buf.length; outB += buf.length;
            } catch (e) { }
        });
        stats = { count: Object.keys(items).length, origBytes: origB, outBytes: outB, compressed: false };
    }

    if (!Object.keys(items).length) return empty;

    // ---- 主包里的 media 值换成引用 ----
    Object.keys(media).forEach(function (k) {
        const it = items[k];
        if (it) qc.media[k] = { __m: it.id, w: it.w, h: it.h };
    });
    dataJson.llm_qc_v1 = (typeof qcRaw === 'string') ? JSON.stringify(qc) : qc;

    return { items: items, buffers: buffers, mode: mode, stats: stats };
}

// 把压缩后的图片逐张加密写入 media/<id>.enc，并清掉不再被引用的旧文件
function writeMediaFiles(buffers, key) {
    if (!buffers || !buffers.length) return { files: 0, bytes: 0, dropped: 0, skipped: true };
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const keep = {};
    let total = 0;
    buffers.forEach(function (f) {
        const sha = crypto.createHash('sha256').update(f.buffer).digest();
        const id = sha.subarray(0, 8).toString('hex');
        // 确定性 iv：从内容哈希派生。同一张图 → 同一密文 → git 里不会反复产生新版本
        const iv = sha.subarray(8, 20);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([c.update(f.buffer), c.final()]);
        const payload = {
            v: 1, alg: 'AES-256-GCM',
            iv: iv.toString('base64'),
            tag: c.getAuthTag().toString('base64'),
            data: enc.toString('base64')
        };
        fs.writeFileSync(path.join(MEDIA_DIR, id + MEDIA_EXT), JSON.stringify(payload));
        keep[id + MEDIA_EXT] = 1;
        total += f.buffer.length;
    });
    // 清理孤儿（图片被替换/删除后留下的旧密文）
    let dropped = 0;
    try {
        fs.readdirSync(MEDIA_DIR).forEach(function (name) {
            if (name.slice(-MEDIA_EXT.length) !== MEDIA_EXT) return;
            if (!keep[name]) { fs.unlinkSync(path.join(MEDIA_DIR, name)); dropped++; }
        });
    } catch (e) { }
    return { files: Object.keys(keep).length, bytes: total, dropped: dropped };
}
if (!fs.existsSync(dataPath)) {
    console.error('[ERR] data.json 不存在：', dataPath);
    console.error('      请先把「工作台完整数据包」复制到本目录，重命名为 data.json');
    process.exit(1);
}

const plaintext = fs.readFileSync(dataPath, 'utf8');
let dataJson;
try { dataJson = JSON.parse(plaintext); }
catch (e) { console.error('[ERR] data.json 不是合法 JSON：', e.message); process.exit(1); }

// 历史数据包里，每个模块可能被存成 JSON 字符串。统一解析成对象/数组。
function parseVal(v) {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return v; }
}
const sched = parseVal(dataJson.schedAppV2) || {};
const board = parseVal(dataJson.llm_board_data) || {};

// 1. 图片外部化（必须在加密之前：主包加密的是「只剩引用」的精简版）
const mediaPack = externalizeMedia(dataJson);

// 2. salt + 派生密钥
//    salt 生成后固定沿用（从已有 data.enc.json 继承）。因为图片用「确定性 iv」加密，
//    只有 key 恒定，同一张图每次打包才生成完全相同的密文 → git 仓库不会越滚越大。
let salt = null;
if (!NEW_SALT) {
    try {
        const prev = JSON.parse(fs.readFileSync(path.join(here, 'data.enc.json'), 'utf8'));
        if (prev && prev.salt) salt = Buffer.from(prev.salt, 'base64');
    } catch (e) { }
}
if (!salt || salt.length !== 16) salt = crypto.randomBytes(16);
const key = crypto.pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256');

// 2. 统一时间戳：加密前先把 _exportedAt 写进明文数据本身
//    （否则密文里是旧导出时间、meta 里是 build 时间，两边永远对不上 → 胶囊永远红）
let exportedAt = new Date().toISOString();
if (KEEP_STAMP) {
    try {
        const prev = JSON.parse(fs.readFileSync(path.join(here, 'data.meta.json'), 'utf8'));
        if (prev && prev._exportedAt) {
            exportedAt = prev._exportedAt;
            console.log('[INFO] --keep-stamp：沿用已有 _exportedAt = ' + exportedAt);
        }
    } catch (e) { console.log('[WARN] --keep-stamp 未找到可沿用的 data.meta.json，改用当前时间'); }
}
dataJson._exportedAt = exportedAt;
const plaintextOut = JSON.stringify(dataJson, null, 2);

// 3. AES-256-GCM 加密（加密的是带新时间戳的明文）
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(plaintextOut, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

// 4. 打包密文
const payload = {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: 100000,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
    exportedAt: exportedAt
};
fs.writeFileSync(path.join(here, 'data.enc.json'),
    JSON.stringify(payload, null, 2));

// 4.5 图片逐张加密写入 media/<id>.enc，并清掉不再被引用的旧图片
const mediaWrite = writeMediaFiles(mediaPack.buffers, key);
fs.rmSync(MEDIA_TMP, { recursive: true, force: true });

// 5. 版块指纹 _fp：客服端靠它把「云端有更新」精确到具体版块（产品 / 班表 / 绩效 / 质检）
//    指纹取自 data.json 里各模块的原始值（客服端同步时原样写入 localStorage），
//    只要模块内容不变，指纹就不变；内容一改，指纹立刻变。
const FP_MODULES = {
    product: ['liuliumei_products', 'liuliumei_tags'],              // 产品资料 + 标签
    schedule: ['schedAppV2'],                                        // 智能班表
    perf: ['llm_board_data', 'llm_board_data_history', 'llm_perf_rule'], // 数据看板 / 绩效规则
    qc: ['llm_qc_v1']                                                // 质检分析
};
// 指纹算法版本 FP_VERSION
//   1 = 原始口径（质检图片以 base64 内嵌在 llm_qc_v1 里）
//   2 = 质检图片改为外置存储后（llm_qc_v1 里只剩 {__m:id} 引用）
// 图片存储形态一变，指纹必然变，但「数据内容」其实没变 →
// 客服端会看到「质检有更新」的误报。带上版本号后，
// 客服端发现版本号落后就静默对齐指纹，不再误报（仅此一次过渡）。
const FP_VERSION = 2;
function fpOf(keys) {
    const parts = keys.map(function (k) {
        const v = dataJson[k];
        const s = (v === undefined || v === null) ? ''
            : (typeof v === 'string' ? v : JSON.stringify(v));
        return k + '=' + s;
    });
    return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}
const fp = {};
Object.keys(FP_MODULES).forEach(function (mod) { fp[mod] = fpOf(FP_MODULES[mod]); });

// 6. 元数据（不含敏感数据，可推到仓库用于胶囊显示）
const products = parseVal(dataJson.liuliumei_products) || [];
const meta = {
    _exportedAt: exportedAt,
    _fpv: FP_VERSION,   // 指纹算法版本：客服端据此静默跳过「指纹口径升级」的误报
    // 图片解密参数（salt 本身不是秘密，PBKDF2 的 salt 按设计就是公开的）
    _kdf: { salt: salt.toString('base64'), iter: 100000 },
    _media: { n: mediaWrite.files, bytes: mediaWrite.bytes, mode: mediaPack.mode },
    _serviceCount: (board.service || []).length,
    _aftersaleCount: (board.aftersale || []).length,
    _productCount: products.length,
    _staffCount: (sched.people || []).length,
    _fp: fp
};
fs.writeFileSync(path.join(here, 'data.meta.json'),
    JSON.stringify(meta, null, 2));

console.log('');
console.log('[OK] 加密完成：');
console.log('     data.enc.json (密文，可推公开仓库)');
console.log('     data.meta.json (元数据，可推公开仓库)');
console.log('     media/*.enc   (质检图片密文，可推公开仓库)');
console.log('');
if (mediaPack.mode === 'pillow') {
    console.log('     图片：' + mediaWrite.files + ' 张，压缩后 ' + (mediaWrite.bytes / 1024).toFixed(1) + ' KB'
        + '（原始 ' + (mediaPack.stats.origBytes / 1024).toFixed(1) + ' KB → ' + mediaPack.stats.ratio + '%）');
} else if (mediaPack.mode === 'js') {
    console.log('     图片：' + mediaWrite.files + ' 张，' + (mediaWrite.bytes / 1024).toFixed(1)
        + ' KB ⚠ 未压缩（未找到 Pillow，仅做了外置）');
} else {
    console.log('     图片：数据里没有内嵌图片');
}
if (mediaWrite.dropped) console.log('     已清理 ' + mediaWrite.dropped + ' 个不再引用的旧图片');
console.log('     主包明文：' + (Buffer.byteLength(plaintextOut, 'utf8') / 1024).toFixed(1) + ' KB（外部化前 '
    + (Buffer.byteLength(plaintext, 'utf8') / 1024).toFixed(1) + ' KB）');
console.log('');
console.log('     明细条数：' + meta._serviceCount);
console.log('     售后条数：' + meta._aftersaleCount);
console.log('     产品数量：' + meta._productCount);
console.log('     班表人数：' + meta._staffCount);
console.log('     导出时间：' + exportedAt);
console.log('');
console.log('     版块指纹（用于客服端精确提示哪个版块更新）：');
console.log('       产品 ' + fp.product);
console.log('       班表 ' + fp.schedule);
console.log('       绩效 ' + fp.perf);
console.log('       质检 ' + fp.qc);
console.log('');
console.log('下一步：双击 sync.bat 推送到 GitHub + Gitee');
console.log('');
