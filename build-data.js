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

const PASSWORD = process.env.LLM_PASSWORD || process.argv[2];
if (!PASSWORD) {
    console.error('Usage: LLM_PASSWORD=<your_password> node build-data.js');
    console.error('   or: node build-data.js <your_password>');
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
const exportedAt = new Date().toISOString();
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

// 4. 元数据（不含敏感数据，可推到仓库用于胶囊显示）
const products = parseVal(dataJson.liuliumei_products) || [];
const meta = {
    _exportedAt: exportedAt,
    _serviceCount: (board.service || []).length,
    _aftersaleCount: (board.aftersale || []).length,
    _productCount: products.length,
    _staffCount: (sched.people || []).length
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
console.log('下一步：双击 sync.bat 推送到 GitHub + Gitee');
console.log('');
