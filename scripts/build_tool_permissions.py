"""工具权限图生成器：以同一布局输出 SVG、可编辑 Draw.io 和 PNG。

仅重建 diagrams/tool-permissions.*，不运行模型或工具，不修改产品状态。
使用 Pillow 测量中文文字，生成前检查文本溢出；PNG 与矢量格式共用坐标和连线。
运行需 Pillow 和中文字体，可用 --font 指定本机字体文件。
"""

import argparse
from html import escape
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 1440, 1110, 2
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
       '<title id="title">MyAgent 工具执行的权限与隔离</title>',
       '<desc id="desc">资源级权限与命令级权限分别检查，合并后允许、询问或拒绝；用户批准绑定本次操作，派发前复核，OS 沙箱限制真实执行。</desc>',
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


# 标题与阶段导航使用统一基线；正文只保留当前已实现的三层控制和必要审批分支。
text(48, 34, "MYAGENT  /  TOOL EXECUTION", 17, MUTED, width=650)
text(48, 79, "工具执行的权限与隔离", 44, INK, True, width=1100)
text(48, 148, "命令获准启动，也必须留在已授权的资源范围内。", 23, MUTED, width=1250)
rule(48, 201, 1344)
for x, n, title, subtitle in [
    (48, "01", "权限判断", "资源与命令，分别检查"),
    (536, "02", "审批决策", "需要授权时，交给用户"),
    (962, "03", "隔离执行", "复核通过后，进入受控环境"),
]:
    badge(x, 229, 44, n, MUTED, "#EFF3F6")
    text(x+60, 230, title, 27, INK, True, width=320)
    text(x, 274, subtitle, 20, MUTED, width=420)

# 分区卡片先画背景，之后画连线和文字，确保箭头不穿越内容。
rect("resource", 48, 325, 390, 218, "#F7FAFD", "#DCE6F0")
rect("command", 48, 579, 390, 333, "#F7FAFD", "#DCE6F0")
rect("decision", 536, 325, 330, 160, "#FFFFFF", "#DCE3E9")
rect("approval", 536, 563, 330, 248, "#FFFCF6", "#E9DDC6")
rect("stop", 536, 858, 330, 54, "#FCF5F4", "#F0DFDC", 12)
rect("recheck", 962, 325, 430, 160, "#FFFFFF", "#DCE3E9")
rect("sandbox", 962, 563, 430, 349, "#F3FAF6", "#CEE5D7")
rect("result", 962, 958, 430, 56, "#FFFFFF", "#CEE5D7", 12)

edge("resource", "decision", [(438,430),(485,430),(485,402),(536,402)], BLUE)
edge("command", "decision", [(438,744),(485,744),(485,402),(536,402)], BLUE)
edge("decision", "recheck", [(866,402),(962,402)], GREEN)
edge("decision", "approval", [(701,485),(701,563)], AMBER)
edge("approval", "recheck", [(866,685),(916,685),(916,402),(962,402)], GREEN)
edge("approval", "stop", [(701,811),(701,858)], RED)
edge("recheck", "sandbox", [(1177,485),(1177,563)], GREEN)
edge("sandbox", "result", [(1177,912),(1177,958)], GREEN)
badge(884, 363, 62, "允许", GREEN, "#EDF6F0", 17)
badge(651, 508, 100, "需要审批", AMBER, "#FBF2E1", 17)
badge(884, 618, 62, "批准", GREEN, "#EDF6F0", 17)
badge(1210, 509, 112, "复核通过", GREEN, "#EDF6F0", 17)

# 资源层与命令层的文字密度一致；规则示例明确为自定义，避免冒充产品默认白名单。
text(72, 347, "资源级权限", 27, BLUE, True, width=342)
text(72, 391, "能访问哪些资源？", 23, INK, True, width=342)
text(72, 430, "目录读写 / 网络域名 / MCP", 20, MUTED, width=342)
rule(72, 465, 342)
text(72, 482, "工作区内文件默认允许", 21, INK, width=342)
text(72, 514, "跨界查授权 · 显式拒绝优先", 19, MUTED, width=342)

text(72, 601, "命令级权限", 27, BLUE, True, width=342)
badge(272, 601, 142, "exec_command", BLUE, "#EAF0F8", 16)
text(72, 647, "这条命令能启动吗？", 23, INK, True, width=342)
text(72, 688, "解析完整 Shell，逐段检查", 20, MUTED, width=342)
text(72, 722, "低风险自动；其他默认询问", 20, MUTED, width=342)
rule(72, 759, 342)
text(72, 775, "用户级 + 项目级规则", 21, INK, True, width=342)
text(72, 809, '["git", "status"] → allow', 20, BLUE, width=342)
text(72, 840, "参数数组前缀匹配 · 自定义示例", 17, MUTED, width=342)
badge(72, 870, 342, "拒绝  >  询问  >  允许", BLUE, "#EAF0F8", 19)

text(560, 350, "合并两项检查结果", 25, INK, True, width=282)
text(560, 393, "全部获准 → 可继续", 21, GREEN, width=282)
text(560, 431, "任何拒绝 → 不执行", 21, RED, width=282)

text(560, 587, "用户审批", 27, AMBER, True, width=282)
text(560, 631, "展示命令、目录、资源和原因", 19, INK, width=282)
rule(560, 668, 282, "#ECE3D2")
text(560, 686, "命令：仅批准本次调用", 21, INK, True, width=282)
text(560, 728, "纯资源可选授权范围", 19, MUTED, width=282)
text(560, 762, "本次 · 会话 · 工作区", 20, INK, width=282)
text(536, 874, "拒绝 / 过期 → 不执行", 21, RED, width=330, align="center")

text(986, 350, "执行前再复核", 27, INK, True, width=382)
text(986, 396, "绑定调用、参数、资源和版本", 21, MUTED, width=382)
text(986, 436, "排队后 / 派发前，重新检查", 21, MUTED, width=382)

text(986, 588, "OS 隔离沙箱", 28, GREEN, True, width=382)
text(986, 634, "Seatbelt  /  bubblewrap", 20, MUTED, width=382)
rule(986, 671, 382, "#D8E8DD")
text(986, 691, "限制目录读取与写入", 22, INK, width=382)
text(986, 730, "只允许授权网络域名", 22, INK, width=382)
text(986, 769, "凭证、数据、工具链受保护", 22, INK, width=382)
text(986, 809, "固定 PATH · 独立 HOME / TMP", 19, MUTED, width=382)
badge(986, 860, 382, "隔离不可用 → 拒绝执行", GREEN, "#E3F0E7", 20)
text(962, 975, "受控执行 → 结果反馈给模型", 22, GREEN, True, width=430, align="center")

# 必要边界放在一处，不再画远端/恢复等支线干扰本次三层主线。
text(48, 950, "本机沙箱：本地文件、命令与 stdio MCP", 21, INK, width=818)
text(48, 986, "HTTP MCP 的远端内部执行，由远端负责隔离。", 19, MUTED, width=818)
rule(48, 1040, 1344)
text(48, 1062, "交互程序获准启动后，write_stdin 不再逐次审批；权限放行不扩大沙箱资源范围。", 18, MUTED, width=1344)

out = ROOT / "diagrams"
out.mkdir(exist_ok=True)
svg.append("</svg>")
svg_text = "\n".join(svg)
ET.fromstring(svg_text)
(out / "tool-permissions.svg").write_text(svg_text)
xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<mxfile host="myagent" version="24.7.17" type="device"><diagram id="tool-permissions" name="权限与隔离">'
       f'<mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" background="#FFFFFF"><root>'
       + "\n".join(cells) + '</root></mxGraphModel></diagram></mxfile>')
ET.fromstring(xml)
(out / "tool-permissions.drawio").write_text(xml)
image.save(out / "tool-permissions.png")
print(f"Created tool-permissions: {W}x{H} layout, {W*SCALE}x{H*SCALE} PNG; measured text fits.")
