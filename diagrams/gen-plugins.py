"""插件原理图：用同一布局生成 PNG、SVG 与可编辑 Draw.io。

属于文档图源，展示安装确认、Run 版本集合、三类能力提供者和延迟回收。
标明实际服务接入点；标准模式的本地沙箱与 Hook 独立授权不等于所有模式一律沙箱。
不读取用户运行数据，不安装插件，不修改任何产品配置；版本号仅为示意。
复用 Hook 图的离线绘图方法，所有文字经过字体测宽、所有连线具有显式端口。
"""

import argparse
from html import escape
import math
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
W, H, SCALE = 1500, 1360, 2
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
       '<title id="title">MyAgent 插件：安装、接入与版本生命周期</title>',
       '<desc id="desc">本地与 Git 插件经校验和用户确认后发布不可变包。新 Run 冻结三类组件，Skill 提供上下文，MCP 提供工具，Hook 在生命周期触发，执行复用原有权限与隔离。旧引用释放后清理。</desc>',
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


# 主流程仅表达真实能力边界；三条接入线落在不同位置，避免暗示 Skill 本身执行代码。
BFILL, GFILL, AFILL, VFILL = "#EFF5FC", "#EDF8F2", "#FFF6E8", "#F4F0FB"
VIOLET = "#6B57A6"
text(48, 30, "MYAGENT / PLUGINS", 17, MUTED, width=900)
text(48, 66, "一个插件包，接入三类能力", 40, INK, True, width=1370)
text(49, 122, "安装与版本由插件层管理，任务仍由原有 Agent Loop 自主执行。", 23, MUTED, width=1380)

# 01 安装链：先生成候选，再由人确认；发布不会替代业务工具审批。
rect("install-section",40,174,1420,202,"#F7F9FC","#E7EDF2",20)
text(62,191,"01  安装与生效",22,INK,True,width=350)
text(1184,195,"安装不执行脚本",17,MUTED,width=250)
rect("source",62,236,236,108)
text(82,256,"插件来源",25,INK,True,width=195)
text(82,300,"本地目录 / HTTPS Git",18,MUTED,width=200)
rect("preview",350,236,286,108)
text(372,256,"清单解析与预览",25,INK,True,width=240)
text(372,300,"plugin.json · 兼容性与权限",18,MUTED,width=245)
rect("confirm",688,236,290,108,VFILL,"#D9CDEC")
text(710,256,"用户确认准确版本",25,VIOLET,True,width=247)
text(710,300,"用户级 / 项目级",20,VIOLET,width=240)
rect("published",1030,236,408,108,BFILL,"#C6D7EB")
text(1052,254,"PluginService 发布",25,BLUE,True,width=360)
text(1052,299,"不可变包 · SQLite 安装与版本登记",19,MUTED,width=365)
edge("source","preview",[(298,290),(350,290)],BLUE)
edge("preview","confirm",[(636,290),(688,290)],BLUE)
edge("confirm","published",[(978,290),(1030,290)],BLUE)

# 02 三类提供者来自同一份 Run 引用；画成分支不是三套循环。
text(62,412,"02  本轮如何使用",22,INK,True,width=390)
rect("snapshot",518,402,475,80,VFILL,"#D9CDEC")
text(540,419,"Run 固定同一份插件版本集合",25,VIOLET,True,width=430)
text(540,454,"内容哈希 + 组件选择 + 配置引用",18,VIOLET,width=420)
edge("published","snapshot",[(1234,344),(1234,442),(993,442)],VIOLET)
text(1260,404,"新任务开始",19,VIOLET,width=166)
rect("skill",62,544,420,164,BFILL,"#C6D7EB")
rect("mcp",540,544,420,164,GFILL,"#C3DDCD")
rect("hook",1020,544,418,164,AFILL,"#E9D6B6")
for target,cx in [("skill",272),("mcp",750),("hook",1230)]:
    edge("snapshot",target,[(755,482),(755,512),(cx,512),(cx,544)],VIOLET)
badge(82,564,66,"Skill",BLUE,"#DFEAF8",18)
text(166,565,"告诉模型怎么做",25,BLUE,True,width=294)
text(83,613,"目录 → 按需加载完整说明",23,INK,width=376)
text(83,660,"SkillService → ContextService",18,MUTED,width=376)
badge(561,564,70,"MCP",GREEN,"#DCEFE4",18)
text(647,565,"提供可调用的工具",25,GREEN,True,width=289)
text(561,613,"发现工具 → 按需 / 直接提供",22,INK,width=380)
text(561,660,"插件工具 → MCP Runtime",19,MUTED,width=376)
badge(1040,564,70,"Hook",AMBER,"#F7E8CF",18)
text(1128,565,"在固定节点触发",25,AMBER,True,width=289)
text(1041,610,"RunStart → 工具前 / 后 → RunEnd",20,INK,width=380)
text(1041,660,"HookService → 隔离脚本执行",19,MUTED,width=374)

# 原有执行链：Skill 进入上下文，MCP 目录交模型，Hook 由应用层在固定节点触发。
rect("loop",40,770,1420,294,"#F7F9FC","#DCE3EB",20)
text(63,791,"原有 Agent Loop",22,INK,True,width=206)
text(944,797,"模型决定继续调用，或结束回答",22,MUTED,width=484)
rect("context",80,866,400,98)
text(106,885,"组装上下文",26,INK,True,width=345)
text(106,928,"历史 / 规则 / 已加载 Skill",20,MUTED,width=345)
rect("model",585,866,330,98,BFILL,"#C6D7EB")
text(610,885,"请求模型",26,BLUE,True,width=280)
text(610,928,"自主决定回答或行动",20,MUTED,width=280)
rect("execution",1000,854,420,124,GFILL,"#C3DDCD")
text(1021,871,"ToolService / HookService",25,GREEN,True,width=370)
text(1021,916,"沿用权限策略、审批与执行器",21,INK,width=377)
text(1021,951,"标准模式本地隔离；远端按连接调用",18,MUTED,width=378)
edge("skill","context",[(272,708),(272,866)],BLUE)
text(287,737,"操作说明",18,BLUE,width=150)
edge("mcp","model",[(750,708),(750,866)],GREEN)
text(766,737,"工具定义",18,GREEN,width=150)
# 虚线连接生命周期容器，不把全部 Hook 误画成只在模型请求前触发。
edge("hook","loop",[(1230,708),(1230,770)],AMBER,dashed=True)
text(1250,732,"应用层触发",18,AMBER,width=180)
edge("context","model",[(480,915),(585,915)],BLUE)
edge("model","execution",[(915,915),(1000,915)],BLUE)
edge("execution","context",[(1210,978),(1210,1020),(280,1020),(280,964)],GREEN)
text(575,1035,"结果持久化后反馈，继续下一次请求",19,GREEN,width=625)

# 03 生命周期：变更切换新任务的可见集合，既有引用阻止提前删除。
rect("lifecycle",40,1098,1420,218,"#FCFBFE","#E5E0EF",20)
text(62,1113,"03  更新与卸载",22,INK,True,width=370)
rect("change",62,1190,318,76,VFILL,"#D9CDEC")
text(83,1214,"更新 / 禁用 / 卸载",25,VIOLET,True,width=276)
rect("old-run",542,1156,340,62)
text(561,1176,"已有 Run：继续使用旧版本",22,INK,width=301)
rect("new-run",542,1236,340,62,VFILL,"#D9CDEC")
text(561,1255,"新 Run：新版本 / 不再加载",22,VIOLET,width=301)
edge("change","old-run",[(380,1228),(462,1228),(462,1187),(542,1187)],VIOLET)
edge("change","new-run",[(380,1228),(462,1228),(462,1267),(542,1267)],VIOLET)
rect("cleanup",1010,1156,426,142)
text(1032,1173,"旧引用释放后，才物理清理",25,INK,True,width=380)
text(1032,1217,"活动任务 · 进程 · 未知结果须处理",20,MUTED,width=379)
text(1032,1260,"源文件与项目产物保留",20,GREEN,width=379)
edge("old-run","cleanup",[(882,1187),(1010,1187)],VIOLET)
text(48,1332,"标准模式使用沙箱；Hook 独立授权。资源与凭证撤销仍生效。虚线表示生命周期触发。",18,MUTED,width=1380)

# 同一份布局导出，PNG 字体由本机字体文件渲染；XML 另外通过技能验证器检查。
out = ROOT / "diagrams"
svg.append("</svg>")
svg_text = "\n".join(svg)
ET.fromstring(svg_text)
(out / "plugins.svg").write_text(svg_text)
xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
       '<mxfile host="myagent" version="24.7.17" type="device"><diagram id="plugins" name="插件支持链路与原理">'
       f'<mxGraphModel grid="1" gridSize="10" page="1" pageScale="1" pageWidth="{W}" pageHeight="{H}" background="#FFFFFF"><root>'
       + "\n".join(cells) + '</root></mxGraphModel></diagram></mxfile>')
ET.fromstring(xml)
(out / "plugins.drawio").write_text(xml)
image.save(out / "plugins.png")
print(f"Created plugins: {W}x{H}; PNG {W*SCALE}x{H*SCALE}; all text fits.")
