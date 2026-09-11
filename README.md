# xiao-xin

公网地址：https://hey-xiaoxin.github.io/xiao-xin/

## 文件结构

仓库内（公开）：
- `index.html`        - 主页面
- `data.enc.json`     - 加密后的数据包（密文，无密码不可读）
- `data.meta.json`    - 数据包元数据（仅条数 + 时间戳）
- `build-data.js`     - 加密脚本
- `.gitignore`        - 忽略明文数据与本地脚本

本地专用（已在 .gitignore，**永不进仓库**）：
- `build-data.cmd`    - 双击加密 data.json -> data.enc.json
- `sync.bat`          - 双击推送到 GitHub
- `push-first.cmd`    - 首次 / 异常时手动 push
- `data.json`         - 明文数据包（绝不入库）

## 首次部署

1. 确保已经创建 GitHub 仓库 `hey-xiaoxin/xiao-xin`（公开仓库）
2. 双击 `push-first.cmd`，把代码推上去
3. 打开 GitHub 仓库 → Settings → Pages → Source 选 `main` / `(root)` → Save
4. 等 30 秒，页面地址：https://hey-xiaoxin.github.io/xiao-xin/

## 管理员日常使用（每天 1 次）

1. 打开本地工作台 → 数据管理 → 点「导出完整数据包」
2. 把导出的 JSON 文件复制到本目录，重命名为 `data.json`
3. 双击 `build-data.cmd`
4. 双击 `sync.bat`
5. 所有员工刷新页面 → 输入密码 → 自动拉取最新数据

## 员工使用

1. 浏览器打开 https://hey-xiaoxin.github.io/xiao-xin/
2. 首次使用：页面会弹窗要求输入密码
3. 输入管理员群里发的密码 → 自动解密并加载数据
4. 之后每天刷新即可，顶部胶囊会提示数据是否最新

## 数据安全

- `data.enc.json` 是 AES-256-GCM 加密的密文
- 没有密码无法解密
- 密码保存在员工浏览器 localStorage（哈希后，不存原文）
- 员工之间互不知道密码即可独立使用
