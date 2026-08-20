#!/usr/bin/env python3
"""光大普特 沙特展会邀约海报 —— 文字精确排版"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1600, 900

def get_font(size, bold=True):
    # 尝试常见字体路径
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

# 背景
bg = Image.new("RGB", (W, H), (13, 27, 54))  # 深蓝
d = ImageDraw.Draw(bg)

# 顶部品牌区
f_big = get_font(96)
f_mid = get_font(44)
f_sub = get_font(30)
f_small = get_font(26)

CYAN = (56, 189, 248)
WHITE = (245, 249, 255)
GRAY = (170, 190, 210)

d.rectangle([0, 0, W, 240], fill=(10, 20, 40))
d.text((W//2, 70), "GUANGDA TECHNOLOGY", font=f_big, fill=CYAN, anchor="mm")
d.text((W//2, 170), "COAXIAL & FIBER OPTIC CABLES", font=f_mid, fill=WHITE, anchor="mm")

# 产品区标签（中段）
d.text((W//2, 330), "Coaxial Cable  ·  Fiber Optic  ·  Power & Control", font=f_sub, fill=GRAY, anchor="mm")
d.text((W//2, 380), "RG6 / RG11  ·  FTTH Drop  ·  LV/MV  ·  Solar Cables", font=f_small, fill=GRAY, anchor="mm")

# 中部产品描述
d.text((W//2, 470), "High-quality cable solutions for telecom, broadcast & utility networks", font=f_sub, fill=WHITE, anchor="mm")

# 底部展会信息带
d.rectangle([0, 560, W, H], fill=(8, 16, 32))
d.rectangle([0, 560, W, 564], fill=CYAN)

d.text((W//2, 610), "SAUDI ARABIA EXHIBITION", font=f_mid, fill=WHITE, anchor="mm")
d.text((W//2, 680), "Riyadh Front Exhibition & Conference Center", font=f_sub, fill=CYAN, anchor="mm")
d.text((W//2, 740), "December 9–11, 2026", font=f_mid, fill=WHITE, anchor="mm")

d.text((W//2, 820), "Welcome to visit our booth — let's talk cables.", font=f_small, fill=GRAY, anchor="mm")

out = "/tmp/guangda_saudi_poster_v2.png"

# ── 合成版：产品背景 + 精确文字 ──
import os as _os
prod_path = "/tmp/guangda_products_bg.png"
if _os.path.exists(prod_path):
    product = Image.open(prod_path).convert("RGB").resize((W, H))
    # 顶部与底部加半透明深色遮罩，保证文字可读
    overlay_top = Image.new("RGBA", (W, H), (0,0,0,0))
    od = ImageDraw.Draw(overlay_top)
    # 顶部渐变遮罩（品牌区）
    for i in range(260):
        alpha = int(200 * (1 - i/260))
        od.line([(0,i),(W,i)], fill=(8,16,32,alpha))
    # 底部展会区遮罩
    for i in range(550, H):
        alpha = int(230 * (1 - (H-1-i)/(H-550)))
        od.line([(0,i),(W,i)], fill=(8,16,32,alpha))
    product = product.convert("RGBA")
    product = Image.alpha_composite(product, overlay_top)
    # 中段产品区遮罩
    mid_mask = Image.new("RGBA", (W, H), (0,0,0,0))
    md = ImageDraw.Draw(mid_mask)
    md.rounded_rectangle([W//2-560, 360, W//2+560, 520], radius=18, fill=(8,16,32,210))
    product = Image.alpha_composite(product, mid_mask).convert("RGB")
    d = ImageDraw.Draw(product)
    # 重画文字（在遮罩上）
    d.text((W//2, 40), "GUANGDA TECHNOLOGY", font=f_big, fill=CYAN, anchor="mm")
    d.rectangle([W//2-340, 105, W//2+340, 113], fill=(20,160,220))
    d.text((W//2, 150), "COAXIAL & FIBER OPTIC CABLES", font=f_mid, fill=WHITE, anchor="mm")
    d.text((W//2, 648), "SAUDI ARABIA EXHIBITION", font=f_mid, fill=WHITE, anchor="mm")
    d.text((W//2, 715), "Riyadh Front Exhibition & Conference Center", font=f_sub, fill=WHITE, anchor="mm")
    d.text((W//2, 775), "December 9–11, 2026", font=f_mid, fill=CYAN, anchor="mm")
    d.text((W//2, 845), "Welcome to visit our booth — let's talk cables.", font=f_small, fill=GRAY, anchor="mm")

    # 产品英文简介（中段，在遮罩内）
    d.text((W//2, 400), "OUR PRODUCTS", font=f_small, fill=CYAN, anchor="mm")
    d.text((W//2, 448), "Coaxial Cable (RG6/RG11)  ·  Fiber Optic Cable (FTTH Drop, Indoor/Outdoor)", font=f_small, fill=WHITE, anchor="mm")
    d.text((W//2, 492), "Power & Control Cable (LV/MV)  ·  Solar Cable  ·  Communication Cable  ·  Fiber Optic Jumper", font=f_small, fill=WHITE, anchor="mm")
    out = "/tmp/guangda_saudi_poster_final.png"
    product.convert("RGB").save(out)
    print("saved composited", out)
