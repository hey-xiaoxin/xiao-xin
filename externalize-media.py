# -*- coding: utf-8 -*-
"""
外部化质检图片（打包流程第一步）

从 data.json 的 llm_qc_v1.media 里提取内嵌的 base64 图片，
压缩为 256 色调色板 PNG，按「压缩后明文的 sha256」命名，
输出到 <out_dir>/<id>.png（明文，供 build-data.js 紧接着加密）。

不修改 data.json —— 结果通过 stdout 的 JSON 回传给 build-data.js。
这样 data.json 始终保持「完整数据包」原样，可反复运行。

用法:
    externalize-media.py <data.json> <out_dir> [--no-compress]

stdout(JSON):
    { "ok": true,
      "items": { "<mediaKey>": {"id","w","h","s"} , ... },
      "files": [ {"id","src","w","h","bytes"} , ... ],
      "stats": { "count","origBytes","outBytes","compressed" } }
"""
import sys, os, io, json, base64, hashlib

def log(*a):
    print(*a, file=sys.stderr)

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    no_compress = '--no-compress' in sys.argv
    if len(args) < 2:
        print(json.dumps({"ok": False, "error": "usage: externalize-media.py <data.json> <out_dir> [--no-compress]"}))
        return 1
    data_path, out_dir = args[0], args[1]

    try:
        with open(data_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "读取 data.json 失败: %s" % e}))
        return 1

    qc_raw = data.get('llm_qc_v1')
    if qc_raw is None:
        print(json.dumps({"ok": True, "items": {}, "files": [], "stats": {"count": 0, "origBytes": 0, "outBytes": 0, "compressed": False}}))
        return 0
    try:
        qc = json.loads(qc_raw) if isinstance(qc_raw, str) else qc_raw
    except Exception as e:
        print(json.dumps({"ok": False, "error": "llm_qc_v1 解析失败: %s" % e}))
        return 1

    media = qc.get('media') or {}

    # Pillow 是否可用（不可用时降级为「只外置、不压缩」）
    PIL = None
    if not no_compress:
        try:
            from PIL import Image
            PIL = Image
        except Exception as e:
            log('[WARN] Pillow 不可用(%s)，降级为「只外置不压缩」' % e)
            no_compress = True

    os.makedirs(out_dir, exist_ok=True)

    items, files = {}, []
    orig_total = out_total = 0
    skipped = 0

    for key, val in media.items():
        # 幂等保护：已经是引用对象就跳过（防止误把外部化后的文件当输入）
        if not isinstance(val, str) or not val.startswith('data:'):
            skipped += 1
            continue
        try:
            head, b64 = val.split(',', 1)
            raw = base64.b64decode(b64)
        except Exception:
            skipped += 1
            continue

        orig_total += len(raw)
        outb = raw
        w = h = 0

        if PIL is not None:
            try:
                im = PIL.open(io.BytesIO(raw))
                w, h = im.size
                # 带透明通道的图不做调色板量化（会丢透明），保持原样
                if im.mode not in ('RGBA', 'LA', 'PA'):
                    rgb = im.convert('RGB')
                    buf = io.BytesIO()
                    rgb.convert('P', palette=PIL.ADAPTIVE, colors=256).save(
                        buf, 'PNG', optimize=True)
                    cand = buf.getvalue()
                    # 量化后反而变大（小图/纯色图）→ 用原图
                    if len(cand) < len(raw):
                        outb = cand
                    else:
                        outb = raw
            except Exception as e:
                log('[WARN] 压缩失败，保留原图: %s (%s)' % (key, e))
                outb = raw
        else:
            # 降级：至少读出尺寸
            try:
                if raw[:8] == b'\x89PNG\r\n\x1a\n':
                    w = int.from_bytes(raw[16:20], 'big')
                    h = int.from_bytes(raw[20:24], 'big')
            except Exception:
                pass

        out_total += len(outb)
        sha = hashlib.sha256(outb).hexdigest()
        mid = sha[:16]                     # 内容寻址 id
        dst = os.path.join(out_dir, mid + '.png')
        if not os.path.exists(dst):
            with open(dst, 'wb') as f:
                f.write(outb)

        items[key] = {"id": mid, "w": w, "h": h, "s": len(outb)}
        files.append({"id": mid, "src": dst, "w": w, "h": h, "bytes": len(outb)})

    stats = {
        "count": len(items),
        "origBytes": orig_total,
        "outBytes": out_total,
        "compressed": (PIL is not None),
        "skipped": skipped,
        "ratio": round(out_total * 100.0 / orig_total, 1) if orig_total else 0,
    }
    if skipped:
        log('[INFO] 跳过 %d 个非 base64 条目' % skipped)
    print(json.dumps({"ok": True, "items": items, "files": files, "stats": stats}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    sys.exit(main())
