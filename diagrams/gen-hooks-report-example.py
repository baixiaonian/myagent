"""Hook 报告示例原理图：共用布局生成 PNG、SVG 和可编辑 Draw.io。

只绘制示意配置、脚本通信和写文件前的拒绝反馈；不创建 Hook、不运行脚本。
复用工具权限图的离线图形部件，使用 Pillow 测宽，禁止文字静默溢出。
本图展示模型选择调整的一个分支，不承诺 Hook 自动改写工具参数。
"""

import argparse
from html import escape
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 1480, 1150, 2
INK, MUTED, LINE = "#1F3042", "#647488", "#CBD5DF"
BLUE, GREEN, AMBER, RED = "#3566A8", "#26755B", "#9B691D", "#AC4A49"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--font", type=Path)
args = parser.parse_args()
font_path = args.font or next(
    (p for p in map(Path, [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
    ]) if p.exists()), None)
if not font_path:
    raise SystemExit("需要中文字体，请使用 --font 指定字体文件。")

image = Image.new("RGB", (W * SCALE, H * SCALE), "white")
draw = ImageDraw.Draw(image)
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
       '<title id="title">MyAgent Hook：报告路径检查</title>',
       '<desc id="desc">配置预览与授权后，在新 Run 冻结脚本版本。写文件前自动检查，拒绝反馈给模型，模型可调整路径，再通过 Hook 与原有权限后执行。</desc>',
       f'<rect width="{W}" height="{H}" fill="#FFFFFF"/>']
cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
positions = {}
sequence = 0


def ident(prefix):
    """保证装饰文本和连线也有稳定且不重复的 Draw.io cell 身份。"""
    global sequence
    sequence += 1
    return f"{prefix}-{sequence}"


def cell(key, x, y, w, h, value, style):
    positions[key] = (x, y, w, h)
    cells.append(f'<mxCell id="{key}" value="{escape(value, quote=True)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')


def rect(key, x, y, w, h, fill="#FFFFFF", stroke="#D9E2EB", radius=16, thickness=1):
    draw.rounded_rectangle((x*SCALE, y*SCALE, (x+w)*SCALE, (y+h)*SCALE), radius=radius*SCALE, fill=fill, outline=stroke, width=max(1, round(thickness*SCALE)))
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{thickness}"/>')
    cell(key, x, y, w, h, "", f'rounded=1;absoluteArcSize=1;arcSize={radius};html=1;fillColor={fill};strokeColor={stroke};strokeWidth={thickness};fontFamily=Hiragino Sans GB')


def text(x, y, value, size=22, color=INK, bold=False, width=None, align="left"):
    """y 为文本框顶部；按真实字体测宽，禁止通过静默缩小字体掩盖溢出。"""
    font = ImageFont.truetype(str(font_path), round(size*SCALE))
    measured = draw.textlength(value, font=font) / SCALE
    if width is not None and measured > width + 1:
        raise ValueError(f"文字超宽 {measured:.1f}>{width}: {value}")
    actual_x = x if align == "left" else x + ((width or measured)-measured)/2
    draw.text((actual_x*SCALE, y*SCALE), value, font=font, fill=color, anchor="lt", stroke_width=round(.22*SCALE) if bold else 0)
    # SVG 与 Draw.io 的文字采用独立可编辑对象，预留同样的行高及固定宽度。
    svg.append(f'<text x="{actual_x}" y="{y}" dominant-baseline="text-before-edge" font-family="Hiragino Sans GB,PingFang SC,Microsoft YaHei,sans-serif" font-size="{size}" font-weight="{600 if bold else 400}" fill="{color}">{escape(value)}</text>')
    cell(ident("text"), x, y-2, width or measured+8, size*1.55, value,
         f'text;html=1;fillColor=none;strokeColor=none;align={align};verticalAlign=top;spacing=0;fontSize={size};fontColor={color};fontStyle={1 if bold else 0};fontFamily=Hiragino Sans GB;whiteSpace=wrap')


def rule(x, y, width, color="#E7EDF2"):
    draw.line((x*SCALE, y*SCALE, (x+width)*SCALE, y*SCALE), fill=color, width=2)
    svg.append(f'<path d="M{x} {y}H{x+width}" fill="none" stroke="{color}"/>')
    cell(ident("rule"), x, y, width, 1, "", f'html=1;fillColor={color};strokeColor=none')


def badge(x, y, w, value, color, fill, size=18):
    rect(ident("badge"), x, y, w, 32, fill, fill, 8)
    text(x, y+5, value, size, color, width=w, align="center")


def edge(source, target, points, color=LINE, arrow=True, dashed=False):
    """同时输出显式正交路径与端口；所有跨卡片路线都在预留沟槽内。"""
    scaled = [(round(x*SCALE), round(y*SCALE)) for x, y in points]
    for a, b in zip(scaled, scaled[1:]):
        if dashed:
            length = math.dist(a, b)
            for offset in range(0, int(length), 18):
                lo, hi = offset/length, min(offset+10, length)/length
                draw.line((a[0]+(b[0]-a[0])*lo, a[1]+(b[1]-a[1])*lo, a[0]+(b[0]-a[0])*hi, a[1]+(b[1]-a[1])*hi), fill=color, width=4)
        else:
            draw.line((a, b), fill=color, width=4)
    if arrow:
        a, b = points[-2:]
        angle = math.atan2(b[1]-a[1], b[0]-a[0])
        triangle = [b, (b[0]-11*math.cos(angle)+5*math.sin(angle), b[1]-11*math.sin(angle)-5*math.cos(angle)), (b[0]-11*math.cos(angle)-5*math.sin(angle), b[1]-11*math.sin(angle)+5*math.cos(angle))]
        draw.polygon([(x*SCALE, y*SCALE) for x,y in triangle], fill=color)
        svg.append('<polygon points="'+" ".join(f"{x},{y}" for x,y in triangle)+f'" fill="{color}"/>')
    svg.append('<polyline points="'+" ".join(f"{x},{y}" for x,y in points)+f'" fill="none" stroke="{color}" stroke-width="2"'+(' stroke-dasharray="5 4"' if dashed else '')+'/>')
    sx, sy, sw, sh = positions[source]
    tx, ty, tw, th = positions[target]
    exit_x, exit_y = (points[0][0]-sx)/sw, (points[0][1]-sy)/sh
    entry_x, entry_y = (points[-1][0]-tx)/tw, (points[-1][1]-ty)/th
    waypoints = ''.join(f'<mxPoint x="{x}" y="{y}"/>' for x,y in points[1:-1])
    if not waypoints:
        waypoints = f'<mxPoint x="{(points[0][0]+points[-1][0])/2}" y="{(points[0][1]+points[-1][1])/2}"/>'
    cells.append(f'<mxCell id="{ident("edge")}" value="" style="edgeStyle=orthogonalEdgeStyle;html=1;rounded=1;strokeWidth=2;strokeColor={color};endArrow={"block" if arrow else "none"};endFill=1;dashed={int(dashed)};exitX={exit_x};exitY={exit_y};entryX={entry_x};entryY={entry_y};exitPerimeter=0;entryPerimeter=0" edge="1" parent="1" source="{source}" target="{target}"><mxGeometry relative="1" as="geometry"><Array as="points">{waypoints}</Array></mxGeometry></mxCell>')


# 上方配置链与下方任务执行分离，确认是配置授权，不是本次业务工具授权。
VIOLET, VFILL, VLINE = "#6B57A6", "#F4F0FB", "#D9CDEC"
BFILL, RFILL, GFILL = "#EFF5FC", "#FCF1EF", "#EDF8F2"
text(52, 30, "MYAGENT  /  HOOK V1", 17, MUTED, width=650)
text(52, 72, "写文件之前，先过项目检查", 42, INK, True, width=1300)
text(52, 131, "例子：报告必须写入 reports/；检查自动触发，路径由模型调整。", 23, MUTED, width=1370)

rect("configuration", 48, 192, 1384, 167, "#F7F9FC", "#E5EAF1", 18)
badge(70, 180, 130, "配置与生效", BLUE, BFILL, 19)
for key, x in [("files", 72), ("confirm", 558), ("snapshot", 1044)]:
    rect(key, x, 229, 364, 104, "#FFFFFF", "#DEE5ED", 12)
text(90, 242, "① 准备配置和脚本", 24, INK, True, width=325)
text(90, 281, "hooks.json  +  main.mjs", 21, MUTED, width=325)
text(576, 242, "② 预览 → 确认授权", 24, INK, True, width=325)
text(576, 281, "绑定配置、包版本和资源范围", 20, MUTED, width=325)
text(1062, 242, "③ 下一 Run 生效", 24, INK, True, width=325)
text(1062, 281, "冻结本轮配置与脚本快照", 21, MUTED, width=325)
edge("files", "confirm", [(436,281),(558,281)], BLUE)
edge("confirm", "snapshot", [(922,281),(1044,281)], BLUE)

# 两行读法按先拒绝、后调整排列；红色反馈回路明确包含一次新的模型请求。
text(72, 398, "一次写报告任务", 26, INK, True, width=520)
text(770, 402, "匹配：PreToolUse · write_file", 21, VIOLET, width=630, align="right")
rect("model1", 72, 456, 364, 134, BFILL, "#C5D8ED", 16)
rect("check1", 558, 456, 364, 134, VFILL, VLINE, 16)
rect("deny", 1044, 456, 364, 134, RFILL, "#E7C9C3", 16)
rect("model2", 72, 731, 364, 134, BFILL, "#C5D8ED", 16)
rect("check2", 558, 731, 364, 134, VFILL, VLINE, 16)
rect("execute", 1044, 731, 364, 134, GFILL, "#BEDCCA", 16)

text(94, 472, "1  模型提出写文件", 25, BLUE, True, width=320)
text(94, 515, "report.txt", 25, INK, width=320)
text(94, 555, "目标：项目根目录", 19, MUTED, width=320)
text(580, 472, "2  程序自动运行 Hook", 24, VIOLET, True, width=320)
text(580, 515, "检查路径是否在 reports/", 22, INK, width=320)
text(580, 555, "此时还未派发写文件工具", 19, MUTED, width=320)
text(1066, 472, "3  deny · 拒绝本次写入", 23, RED, True, width=320)
text(1066, 515, "请改用 reports/ 目录", 23, INK, width=320)
text(1066, 555, "原路径未写入文件", 19, MUTED, width=320)
edge("model1", "check1", [(436,523),(558,523)], BLUE)
edge("check1", "deny", [(922,523),(1044,523)], RED)

edge("deny", "model2", [(1226,590),(1226,655),(254,655),(254,731)], RED)
rect("feedback-label", 496, 635, 490, 41, "#FFFFFF", "#FFFFFF", 1)
text(505, 643, "拒绝原因 → 下一次模型请求", 24, RED, width=470, align="center")

text(94, 747, "4  模型可调整路径", 25, BLUE, True, width=320)
text(94, 790, "reports/report.txt", 24, INK, width=320)
text(94, 830, "重新提出一次工具调用", 19, MUTED, width=320)
text(580, 747, "5  再次检查 · continue", 23, VIOLET, True, width=320)
text(580, 790, "路径符合本例的检查条件", 22, INK, width=320)
text(580, 830, "继续原有权限检查", 19, MUTED, width=320)
text(1066, 747, "6  沙箱内执行工具", 25, GREEN, True, width=320)
text(1066, 790, "reports/report.txt", 24, INK, width=320)
text(1066, 830, "权限通过后，真实保存报告", 19, MUTED, width=320)
edge("model2", "check2", [(436,798),(558,798)], BLUE)
edge("check2", "execute", [(922,798),(1044,798)], GREEN)
text(72, 895, "Hook 不改写参数；示例展示模型收到拒绝后选择调整的分支。", 21, MUTED, width=1320)

# 通信带只保留方向和数据职责；字段限制与管理 API 放在配套文档，避免图面堆文字。
rect("protocol", 48, 961, 1384, 150, "#F8FAFC", "#E1E7ED", 16)
badge(70, 946, 155, "脚本通信协议", MUTED, "#F0F3F7", 19)
rect("stdin", 72, 989, 364, 86, "#FFFFFF", "#E0E7EF", 12)
rect("script", 558, 989, 364, 86, VFILL, VLINE, 12)
rect("stdout", 1044, 989, 364, 86, "#FFFFFF", "#E0E7EF", 12)
text(92, 1000, "stdin · JSON 事件", 24, BLUE, True, width=323)
text(92, 1040, "事件 / 工作区 / 工具参数", 19, MUTED, width=323)
text(578, 1000, "沙箱中的 main.mjs", 24, VIOLET, True, width=323)
text(578, 1040, "可信解释器 + 固定参数", 19, MUTED, width=323)
text(1064, 1000, "stdout · JSON 结果", 24, GREEN, True, width=323)
text(1064, 1040, "continue / deny / 补充上下文", 18, MUTED, width=323)
edge("stdin", "script", [(436,1032),(558,1032)], BLUE)
edge("script", "stdout", [(922,1032),(1044,1032)], GREEN)
text(72, 1120, "stderr → 日志记录；日志不自动成为模型指令。", 18, MUTED, width=1300)

# 从同一布局导出三个格式，图源可以离线编辑；本轮不需要 draw.io 桌面应用。
out = ROOT / "diagrams"
svg.append("</svg>")
svg_text = "\n".join(svg)
ET.fromstring(svg_text)
(out / "hooks-report-example.svg").write_text(svg_text)
xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<mxfile host="myagent" version="24.7.17" type="device"><diagram id="hooks-report-example" name="Hook 报告路径检查">'
       f'<mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" background="#FFFFFF"><root>'
       + "\n".join(cells) + '</root></mxGraphModel></diagram></mxfile>')
ET.fromstring(xml)
(out / "hooks-report-example.drawio").write_text(xml)
image.save(out / "hooks-report-example.png")
print(f"Created hooks-report-example: {W}x{H}; PNG {W*SCALE}x{H*SCALE}; all text fits.")
