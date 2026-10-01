"""插件配置生效链路图：文档模块的可重建图源，输出同布局 PNG、SVG 和 Draw.io。

按当前 PluginService、ChatService 与 Server 装配绘制，不把外部 Hook 兼容层当作已实现。
只生成图表文件，不读取用户运行数据、不安装插件、不修改产品配置。
绘图使用 Pillow 和中文字体，复用既有插件图的布局方法，不引入产品依赖。
"""

import argparse
from html import escape
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 1500, 1510, 2
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
       '<title id="title">MyAgent 插件：从配置到本轮生效</title>',
       '<desc id="desc">插件包声明和管理设置经校验与确认发布。任务开始冻结同一份版本，三类提供者分别进入上下文、工具定义与生命周期。外部 Hook 兼容层尚未实现。</desc>',
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


# 配置到生效：管理发布与任务快照分层，图中服务名均对应实际装配入口。
BFILL, GFILL, AFILL, VFILL = "#EFF5FC", "#EDF8F2", "#FFF6E8", "#F4F0FB"
VIOLET = "#6B57A6"
text(52, 28, "MYAGENT  /  PLUGIN ACTIVATION", 17, MUTED, width=1300)
text(52, 66, "插件从配置到生效", 42, INK, True, width=1320)
text(54, 125, "一份组合包，三条接入路径，复用同一个 Agent Loop。", 23, MUTED, width=1350)

# 一：用户选择来源与管理配置，不把编辑源目录误画成自动热更新。
text(54, 184, "01   配置与安装", 23, INK, True, width=520)
text(982, 188, "Web 设置 → SDK → 插件管理 API", 18, MUTED, width=456)
rect("package", 54, 238, 292, 216, "#F8FAFC", "#D9E2EB")
text(75, 257, "本地目录 / HTTPS Git", 24, INK, True, width=252)
text(77, 306, "plugin.json", 23, INK, width=248)
text(77, 342, "skills/ · mcp.json", 21, MUTED, width=248)
text(77, 377, "Hook: com.myagent", 18, MUTED, width=248)
text(77, 418, "也识别 .codex-plugin 清单", 18, MUTED, width=248)

rect("inspect", 394, 238, 306, 216)
text(416, 257, "捕获候选，解析预览", 25, INK, True, width=264)
text(416, 309, "内容哈希 · 组件 · 权限", 22, INK, width=264)
text(416, 350, "校验文件与兼容性", 22, MUTED, width=260)
text(416, 407, "LocalPluginFiles / extensions", 17, MUTED, width=265)

rect("confirm", 748, 238, 294, 216, VFILL, "#D9CDEC")
text(770, 257, "用户确认准确版本", 25, VIOLET, True, width=251)
text(770, 309, "用户级 / 当前项目", 22, INK, width=251)
text(770, 350, "启停 · 组件设置 · 资源", 21, INK, width=251)
text(770, 407, "绑定包哈希与管理版本", 19, MUTED, width=251)

rect("publish", 1090, 238, 356, 216, BFILL, "#C6D7EB")
text(1112, 257, "发布与登记", 25, BLUE, True, width=310)
text(1112, 309, "不可变包 → 数据库引用", 22, INK, width=310)
text(1112, 350, "保存安装、作用域与组件配置", 20, MUTED, width=312)
text(1112, 407, "PluginService.confirm", 21, BLUE, width=310)
for a,b,x1,x2 in [("package","inspect",346,394),("inspect","confirm",700,748),("confirm","publish",1042,1090)]:
    edge(a,b,[(x1,345),(x2,345)],BLUE)
rect("compat",394,479,648,56,"#FCF3F2","#EDDCDA",10)
text(412,496,"当前：外部 Hook 未适配 → 阻断启用，需适配或明确排除",18,RED,width=615)
edge("inspect","compat",[(547,454),(547,479)],RED)
text(63,484,"不执行安装脚本",21,MUTED,width=290)
text(63,518,"不改写手工组件配置",18,MUTED,width=300)

# 二：同一事务冻结插件引用；提供者都查询同一 Run 集合，不能各自切换最新版本。
text(54,580,"02   新任务冻结版本",23,INK,True,width=640)
rect("snapshot",54,632,1392,92,VFILL,"#D9CDEC")
text(77,650,"ChatService → PluginService.initialize",25,VIOLET,True,width=725)
text(78,690,"有效作用域 + 包版本 + 组件选择 + 配置引用",21,INK,width=800)
text(1014,661,"本轮固定，三类能力共用",22,VIOLET,width=409)
edge("publish","snapshot",[(1268,454),(1268,632)],VIOLET)
text(1285,550,"开始 Run",18,VIOLET,width=150)

# 三：三列与实际服务一一对应，只有提供者不同，没有第二套模型循环。
rect("skill",54,790,420,201,BFILL,"#C6D7EB")
rect("mcp",540,790,420,201,GFILL,"#C3DDCD")
rect("hook",1026,790,420,201,AFILL,"#E9D6B6")
for target,cx in [("skill",264),("mcp",750),("hook",1236)]:
    edge("snapshot",target,[(750,724),(750,754),(cx,754),(cx,790)],VIOLET)
text(77,812,"Skill",31,BLUE,True,width=360)
text(77,858,"目录 → 按需加载 SKILL.md",23,INK,width=375)
text(77,900,"显式选择也可首请求前加载",21,MUTED,width=375)
text(77,947,"SkillService → ContextService",18,BLUE,width=375)
text(562,812,"MCP",31,GREEN,True,width=360)
text(562,858,"握手 / tools/list → 工具目录",22,INK,width=375)
text(562,900,"默认按需；可配置直接提供",21,MUTED,width=375)
text(562,947,"MCP Runtime · 按版本 / 项目隔离",18,GREEN,width=375)
text(1048,812,"Hook",31,AMBER,True,width=360)
text(1048,858,"固定时点触发已授权脚本",23,INK,width=375)
text(1048,900,"stdin JSON → 脚本 → stdout JSON",19,INK,width=375)
text(1048,947,"HookService · 独立权限与隔离",18,AMBER,width=375)

# 最下层：三个入口分别落到上下文、模型工具定义和应用生命周期。
rect("loop",40,1070,1420,301,"#F8FAFC","#DCE3EB",20)
text(64,1088,"03   执行循环",22,INK,True,width=185)
rect("hook-events",916,1081,511,63,AFILL,"#E9D6B6",10)
text(931,1092,"RunStart · PreToolUse · PostToolUse · RunEnd",17,AMBER,width=479)
text(932,1119,"应用层触发；模型不负责调用 Hook",17,AMBER,width=470)
edge("hook","hook-events",[(1236,991),(1236,1081)],AMBER,dashed=True)
rect("context",80,1180,382,106)
text(103,1198,"组装上下文",27,BLUE,True,width=334)
text(103,1243,"规则 / 历史 / 已加载 Skill",20,MUTED,width=334)
rect("model",570,1180,360,106,BFILL,"#C6D7EB")
text(594,1198,"请求模型",27,BLUE,True,width=310)
text(594,1243,"接收工具定义，自主决定行动",19,MUTED,width=313)
rect("execute",1038,1180,382,106,GFILL,"#C3DDCD")
text(1060,1198,"受控工具执行",27,GREEN,True,width=336)
text(1060,1243,"ToolService → Worker / MCP",19,MUTED,width=337)
edge("skill","context",[(264,991),(264,1180)],BLUE)
text(280,1024,"说明进入上下文",18,BLUE,width=220)
edge("mcp","model",[(750,991),(750,1180)],GREEN)
text(766,1024,"工具定义",18,GREEN,width=150)
edge("context","model",[(462,1233),(570,1233)],BLUE)
edge("model","execute",[(930,1233),(1038,1233)],BLUE)
edge("execute","context",[(1229,1286),(1229,1324),(271,1324),(271,1286)],GREEN)
text(572,1338,"结果落库 → 反馈模型 → 继续或结束",19,GREEN,width=660)

# 收口保留最关键的生效/撤销语义，不把更新画成在途热替换。
rule(54,1400,1392)
text(56,1421,"更新 / 禁用 / 卸载 → 新 Run 生效；已有 Run 保留原版本，旧引用释放后清理。",22,INK,width=1386)
text(56,1464,"标准模式本地动作受权限与沙箱约束；Hook 独立授权。资源 / 凭证撤销仍即时约束派发。",18,MUTED,width=1386)

out = ROOT / "diagrams"
svg.append("</svg>")
svg_text = "\n".join(svg)
ET.fromstring(svg_text)
(out / "plugin-activation.svg").write_text(svg_text)
xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<mxfile host="myagent" version="24.7.17" type="device"><diagram id="plugin-activation" name="插件从配置到生效">'
       f'<mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" background="#FFFFFF"><root>'
       + "\n".join(cells) + '</root></mxGraphModel></diagram></mxfile>')
ET.fromstring(xml)
(out / "plugin-activation.drawio").write_text(xml)
image.save(out / "plugin-activation.png")
print(f"Created plugin-activation: {W}x{H}; PNG {W*SCALE}x{H*SCALE}; {len(cells)} cells; all text fits.")
