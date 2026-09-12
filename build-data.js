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

// 密码：环境变量优先，其次取第一个「非 -- 开头」的参数
const cliArgs = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });
const PASSWORD = process.env.LLM_PASSWORD || cliArgs[0];
// --keep-stamp：沿用已有 data.meta.json 的 _exportedAt（仅重算元数据/指纹时用），
//              避免「内容没变、只是重新打包」被客服端当成「有更新」而弹红
const KEEP_STAMP = process.argv.indexOf('--keep-stamp') >= 0 || process.env.LLM_KEEP_STAMP === '1';
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

// 1. 随机 salt + 派生密钥
const salt = crypto.randomBytes(16);
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

// 5. 版块指纹 _fp：客服端靠它把「云端有更新」精确到具体版块（产品 / 班表 / 绩效 / 质检）
//    指纹取自 data.json 里各模块的原始值（客服端同步时原样写入 localStorage），
//    只要模块内容不变，指纹就不变；内容一改，指纹立刻变。
const FP_MODULES = {
    product: ['liuliumei_products', 'liuliumei_tags'],              // 产品资料 + 标签
    schedule: ['schedAppV2'],                                        // 智能班表
    perf: ['llm_board_data', 'llm_board_data_history', 'llm_perf_rule'], // 数据看板 / 绩效规则
    qc: ['llm_qc_v1']                                                // 质检分析
};
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
