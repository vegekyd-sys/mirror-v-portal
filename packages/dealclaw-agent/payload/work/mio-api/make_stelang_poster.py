#!/usr/bin/env python3
"""STELANG 墨西哥展邀请函海报 — 咖啡暖色调"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1600, 1000

def get_font(size, bold=True):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

# 咖啡暖色背景（渐变模拟：深咖啡色）
bg = Image.new("RGB", (W, H), (58, 32, 20))
d = ImageDraw.Draw(bg)

# 顶部深色条
d.rectangle([0, 0, W, 170], fill=(45, 24, 15))

CREAM = (244, 234, 220)
GOLD = (224, 164, 90)
WHITE = (255, 250, 242)
DIM = (200, 175, 150)

f_brand = get_font(88)
f_title = get_font(60)
f_mid = get_font(44)
f_sub = get_font(30)
f_small = get_font(26)

# 品牌
d.text((W//2, 60), "STELANG", font=f_brand, fill=GOLD, anchor="mm")
d.text((W//2, 130), "Foshan Shunde Stelong Electrical Appliance", font=f_small, fill=DIM, anchor="mm")

# 主标题
d.text((W//2, 280), "CHINA HOMELIFE MEXICO 2026", font=f_title, fill=CREAM, anchor="mm")

# 信息区
d.text((W//2, 400), "INVITACI\u00d3N", font=f_mid, fill=GOLD, anchor="mm")
d.text((W//2, 460), "Cafeteras · Molinos · Espumadores de leche", font=f_sub, fill=WHITE, anchor="mm")

# 展位信息卡片
d.rounded_rectangle([W//2-380, 530, W//2+380, 800], radius=20, fill=(70, 42, 25))
d.text((W//2, 570), "Fecha: 8 - 10 Septiembre 2026", font=f_mid, fill=CREAM, anchor="mm")
d.text((W//2, 630), "Recinto: Centro Citibanamex, CDMX", font=f_mid, fill=CREAM, anchor="mm")
d.text((W//2, 690), "Stand: HALL D - B220", font=f_mid, fill=GOLD, anchor="mm")
d.text((W//2, 750), "10-50 USD FOB · OEM/ODM", font=f_sub, fill=WHITE, anchor="mm")

# 优惠
d.text((W//2, 850), "★ 10% de descuento en primer pedido ★", font=f_mid, fill=GOLD, anchor="mm")

# 联系方式底部
d.rectangle([0, 900, W, H], fill=(45, 24, 15))
d.text((W//2, 945), "Lucky Lee +86 134 1825 6321 (WhatsApp)  ·  Maxd +86 137 2804 5799", font=f_small, fill=DIM, anchor="mm")
d.text((W//2, 985), "gb.stelang.com", font=f_small, fill=DIM, anchor="mm")

out = "/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw/media/stelang_invitacion.png"
bg.save(out)
print("已生成:", out)
