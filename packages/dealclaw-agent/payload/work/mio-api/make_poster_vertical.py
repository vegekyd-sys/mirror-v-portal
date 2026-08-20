#!/usr/bin/env python3
"""光大普特 沙特展会竖屏邀约海报 —— 内容丰富 + 沙特元素"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

W, H = 1080, 1920  # 9:16 竖屏

def get_font(size):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

f_big = get_font(110)
f_mid = get_font(46)
f_sub = get_font(34)
f_small = get_font(28)
f_tiny = get_font(24)

CYAN = (56, 189, 248)
GOLD = (240, 190, 90)
WHITE = (245, 249, 255)
GRAY = (185, 200, 215)

prod_path = "/tmp/guangda_vertical_bg2.png"
if not os.path.exists(prod_path):
    raise SystemExit("背景图缺失")

bg = Image.open(prod_path).convert("RGB").resize((W, H))

# 顶部遮罩（品牌区）
overlay = Image.new("RGBA", (W, H), (0,0,0,0))
od = ImageDraw.Draw(overlay)
for i in range(340):
    alpha = int(215 * (1 - i/340))
    od.line([(0,i),(W,i)], fill=(7,14,30,alpha))

# 中间产品卡片遮罩
od.rounded_rectangle([W//2-470, 250, W//2+470, 730], radius=24, fill=(8,18,36,208))

# 底部展会区遮罩
for i in range(1500, H):
    alpha = int(235)
    od.line([(0,i),(W,i)], fill=(7,14,30,alpha))

bg = Image.alpha_composite(bg.convert("RGBA"), overlay).convert("RGB")
d = ImageDraw.Draw(bg)

# ── 顶部：品牌 ──
d.rectangle([W//2-300, 150, W//2+300, 158], fill=(20,160,220))
d.text((W//2, 90), "GUANGDA", font=f_big, fill=CYAN, anchor="mm")
d.text((W//2, 190), "TECHNOLOGY", font=f_mid, fill=WHITE, anchor="mm")
d.text((W//2, 240), "COAXIAL & FIBER OPTIC CABLES", font=f_small, fill=GRAY, anchor="mm")

# ── 中部：产品卡片 ──
d.text((W//2, 300), "OUR PRODUCTS", font=f_sub, fill=CYAN, anchor="mm")
d.rectangle([W//2-200, 320, W//2+200, 322], fill=(40,70,100))

products = [
    ("● Coaxial Cable", "RG6 / RG11 · CATV · Satellite · CCTV"),
    ("● Fiber Optic Cable", "FTTH Drop · Indoor / Outdoor"),
    ("● Power & Control Cable", "LV / MV · Industrial"),
    ("● Solar Cable", "PV Projects"),
    ("● Communication Cable", "Networking & Data"),
    ("● Fiber Optic Jumper", "Patch Cords & Accessories"),
]
y = 360
for title, desc in products:
    d.text((W//2-400, y), title, font=f_sub, fill=WHITE, anchor="lm")
    d.text((W//2-400, y+38), desc, font=f_small, fill=GRAY, anchor="lm")
    y += 86

# 价值点
y = 900
d.text((W//2, y), "WHY GUANGDA", font=f_sub, fill=CYAN, anchor="mm")
y += 50
points = [
    "In-house manufacturing · 201–300 staff · full QC",
    "UL / CE / RoHS support · custom OEM runs",
    "Established Middle East export experience",
    "Competitive pricing · consistent lead times",
]
for p in points:
    d.text((W//2, y), "✓  " + p, font=f_small, fill=WHITE, anchor="mm")
    y += 44

# ── 底部：展会信息 ──
d.rectangle([0, 1560, W, 1564], fill=GOLD)
d.text((W//2, 1600), "SAUDI ARABIA EXHIBITION 2026", font=f_mid, fill=WHITE, anchor="mm")
d.text((W//2, 1660), "Riyadh Front Exhibition & Conference Center", font=f_sub, fill=CYAN, anchor="mm")
d.text((W//2, 1725), "December 9–11", font=get_font(88), fill=GOLD, anchor="mm")
d.text((W//2, 1800), "Welcome to visit our booth — let's talk cables.", font=f_small, fill=GRAY, anchor="mm")
d.text((W//2, 1850), "Guangda Technology · Hangzhou, China", font=f_tiny, fill=GRAY, anchor="mm")

out = "/tmp/guangda_saudi_poster_vertical.png"
bg.convert("RGB").save(out)
print("saved", out)
