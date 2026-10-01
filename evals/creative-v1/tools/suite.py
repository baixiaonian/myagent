#!/usr/bin/env python3
"""创作评测离线工具：准备无裁判材料的工作区、核验输入/交付、生成评分模板并汇总人工分。
属于独立评测资料，不调用 MyAgent、不联网、不执行作品或付费裁判。所有写入使用显式路径；
不覆盖既有工作区/报告。机械检查不证明事实、交互或审美正确，未审项目不补零或冒充通过。
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    # x 模式拒绝覆盖，复评必须使用新文件，保留评分历史。
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write("\n")


def get_case(case_id):
    matches = [c for c in read_json(ROOT / "suite.json")["cases"] if c["id"] == case_id]
    if not matches:
        raise ValueError(f"未知题目：{case_id}")
    return matches[0]


def file_map(path):
    result = {}
    for p in sorted(Path(path).rglob("*")):
        if p.is_symlink():
            raise ValueError(f"不接受符号链接：{p}")
        if p.is_file():
            result[p.relative_to(path).as_posix()] = digest(p)
    return result


def validate():
    """校验冻结包自身；防止题数、权重或事实输入在不同轮次漂移。"""
    suite = read_json(ROOT / "suite.json")
    if len(suite["cases"]) != 8 or len({c["id"] for c in suite["cases"]}) != 8:
        raise ValueError("必须有8个唯一题目")
    for c in suite["cases"]:
        rubric = read_json(ROOT / c["rubric"])
        if sum(d["weight"] for d in rubric["dimensions"]) != 100:
            raise ValueError(f"权重不是100：{c['id']}")
        if not (ROOT / c["prompt"]).is_file() or not file_map(ROOT / c["inputs"]):
            raise ValueError(f"任务或材料缺失：{c['id']}")
        if not rubric["critical_gates"] or not rubric["facts"] or not rubric["review_steps"]:
            raise ValueError(f"裁判依据不完整：{c['id']}")
    expected = read_json(ROOT / "checksums.json")
    for rel, sha in expected.items():
        p = ROOT / rel
        if not p.is_file() or p.is_symlink() or digest(p) != sha:
            raise ValueError(f"冻结文件哈希不一致：{rel}")
    return {"status": "valid", "case_count": 8, "frozen_files": len(expected)}


def prepare(case_id, destination):
    """只复制任务与输入；不将金标准、评分模板或其他案例暴露给被测 Agent。"""
    validate()
    c = get_case(case_id)
    dest = Path(destination).expanduser().resolve()
    if dest.exists():
        raise ValueError("目标已存在；请使用全新工作区，不覆盖已有文件")
    if dest.is_relative_to(ROOT):
        raise ValueError("评测工作区不能放在含裁判材料的评测包内")
    dest.mkdir(parents=True)
    shutil.copyfile(ROOT / c["prompt"], dest / "PROMPT.md")
    shutil.copytree(ROOT / c["inputs"], dest / "inputs")
    (dest / "output").mkdir()
    return {"case_id": case_id, "workspace": str(dest), "prompt": "请阅读工作区 PROMPT.md，按要求完成任务并保存实际作品。"}


def length_units(text):
    # 中文汉字+英文/数字连续词的近似计数；排除代码块，避免代码长度冒充长文正文。
    prose = re.sub(r"```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~", "", text)
    return len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+(?:['_-][A-Za-z0-9]+)*", prose))


def check(case_id, workspace):
    c = get_case(case_id)
    work = Path(workspace).expanduser().resolve()
    if not work.is_dir():
        raise ValueError("工作区不存在")
    failures, warnings = [], []
    # 逐级拒绝链接，不能让作品链接或 inputs 链接把核验引向任意本地文件。
    for rel in ("PROMPT.md", "inputs", "output", c["output"]):
        if (work / rel).is_symlink():
            raise ValueError(f"工作区包含不允许的链接：{rel}")
    expected = file_map(ROOT / c["inputs"])
    actual = file_map(work / "inputs") if (work / "inputs").is_dir() else {}
    if expected != actual:
        failures.append("输入文件被更改、删除或新增")
    if not (work / "PROMPT.md").is_file() or digest(work / "PROMPT.md") != digest(ROOT / c["prompt"]):
        failures.append("任务文件缺失或被改写")
    artifact = work / c["output"]
    sha, units = None, None
    if not artifact.is_file() or artifact.stat().st_size == 0:
        failures.append("指定产物缺失或为空")
    elif artifact.stat().st_size > 20 * 1024 * 1024:
        failures.append("单个产物超过本评测20MiB读取上限，请核验异常内容")
    else:
        sha = digest(artifact)
        text = artifact.read_text(encoding="utf-8")
        if c["length_units"]:
            units = length_units(text)
            low, high = c["length_units"]
            if not low <= units <= high:
                warnings.append(f"正文近似{units}字，目标{low}–{high}；由裁判按实质内容评分，不自动给质量分")
            if not re.search(r"^#\s+\S", text, re.M):
                warnings.append("未发现一级Markdown标题，请检查结构")
        else:
            if not re.search(r"<html(?:\s|>)", text, re.I):
                failures.append("产物不是完整HTML文档")
            for name, pattern in [("页面标题", r"<title>\s*\S"), ("viewport", r'name\s*=\s*[\"\']viewport[\"\']')]:
                if not re.search(pattern, text, re.I):
                    warnings.append(f"未发现{name}")
            if re.search(r'(?:src\s*=\s*[\"\']https?://|@import|url\(\s*[\"\']?https?://)', text, re.I):
                warnings.append("发现可能的外部资源引用；需浏览器断网验证，静态检查不是完整依赖检测")
    return {"case_id": case_id, "artifact": str(artifact), "artifact_sha256": sha,
            "mechanical_ok": not failures, "failures": failures, "warnings": warnings,
            "length_units": units, "quality_status": "requires_review"}


def template(case_id):
    rubric = read_json(ROOT / get_case(case_id)["rubric"])
    return {"case_id": case_id, "reviewer": "", "reviewer_kind": "human_or_model",
            "artifact_sha256": None, "critical_gates_passed": None, "critical_evidence": [],
            "dimensions": [{"id": d["id"], "score": None, "evidence": [], "reason": ""} for d in rubric["dimensions"]],
            "browser_checks_completed": None, "screenshots": [], "notes": "",
            "metrics": {"wall_seconds": None, "model_requests": None, "input_tokens": None,
                        "cached_input_tokens": None, "output_tokens": None, "known_cost": None,
                        "currency": None, "unpriced_requests": None, "trace_id": None}}


def score(case_id, workspace, review_path):
    """只汇总有产物证据的完整评分；质量与效率分开，金额缺失保持未知。"""
    result = check(case_id, workspace)
    review = read_json(review_path)
    rubric = read_json(ROOT / get_case(case_id)["rubric"])
    if review.get("case_id") != case_id:
        raise ValueError("评分题目不匹配")
    if not result["artifact_sha256"] or review.get("artifact_sha256") != result["artifact_sha256"]:
        raise ValueError("评分未绑定当前产物SHA256；不能将旧作品分数用于新作品")
    if not review.get("reviewer") or type(review.get("critical_gates_passed")) is not bool or not review.get("critical_evidence"):
        raise ValueError("裁判身份、关键条件核查或依据未填写")
    is_html = get_case(case_id)["output"].endswith(".html")
    if is_html and (review.get("browser_checks_completed") is not True or not review.get("screenshots")):
        raise ValueError("HTML必须完成实际浏览器步骤并记录截图，不能仅根据源码评分")
    dims = review.get("dimensions", [])
    if len(dims) != len(rubric["dimensions"]) or {d.get("id") for d in dims} != {d["id"] for d in rubric["dimensions"]}:
        raise ValueError("评分维度缺失、重复或未知")
    total = 0
    by_id = {d["id"]: d for d in dims}
    for target in rubric["dimensions"]:
        got = by_id[target["id"]]
        value = got.get("score")
        if type(value) is not int or not 0 <= value <= 4 or not got.get("evidence") or not got.get("reason"):
            raise ValueError(f"{target['id']}需要0–4整数分、依据及理由")
        total += target["weight"] * value / 4
    result.update({"quality_score": total, "critical_gates_passed": review["critical_gates_passed"],
                   "pass": result["mechanical_ok"] and review["critical_gates_passed"] and total >= 80 and by_id["D1"]["score"] >= 3,
                   "quality_status": "reviewed", "reviewer": review["reviewer"], "metrics": review.get("metrics", {})})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("validate")
    p = sub.add_parser("prepare"); p.add_argument("case_id"); p.add_argument("destination")
    p = sub.add_parser("check"); p.add_argument("case_id"); p.add_argument("workspace")
    p = sub.add_parser("template"); p.add_argument("case_id"); p.add_argument("review_file")
    p = sub.add_parser("score"); p.add_argument("case_id"); p.add_argument("workspace"); p.add_argument("review_file")
    args = parser.parse_args()
    if args.command == "validate": result = validate()
    elif args.command == "prepare": result = prepare(args.case_id, args.destination)
    elif args.command == "check": result = check(args.case_id, args.workspace)
    elif args.command == "template":
        write_json(args.review_file, template(args.case_id)); result = {"template": args.review_file}
    else: result = score(args.case_id, args.workspace, args.review_file)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("mechanical_ok") is False or result.get("pass") is False:
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"评测工具错误：{error}", file=sys.stderr)
        sys.exit(2)
