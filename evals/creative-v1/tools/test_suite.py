"""独立创作评测工具回归：核验盲测复制、产物版本、未评状态和人工评分边界。
测试只在临时目录写入占位产物，不调用模型、不把工具自检宣称为写作任务通过。
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("creative_suite", Path(__file__).with_name("suite.py"))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


class SuiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.case = "01-tech-article"
        self.work = self.base / "work"
        suite.prepare(self.case, self.work)

    def tearDown(self):
        self.temp.cleanup()

    def review(self, case=None, html=False):
        case = case or self.case
        c = suite.get_case(case)
        artifact = self.work / c["output"]
        artifact.write_text("<!doctype html><html><title>test</title><body>fixture</body></html>" if html else "# 测试占位产物\n仅测试评分工具，不是真实文章。", encoding="utf-8")
        doc = suite.template(case)
        doc.update(reviewer="unit-test-only", artifact_sha256=suite.digest(artifact), critical_gates_passed=True, critical_evidence=["测试自造的评分，非真实任务结论"])
        for d in doc["dimensions"]:
            d.update(score=4, evidence=["测试夹具"], reason="验证计算")
        path = self.base / "review.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        return doc, path

    def test_preparation_excludes_graders(self):
        self.assertEqual({p.name for p in self.work.iterdir()}, {"PROMPT.md", "inputs", "output"})
        with self.assertRaises(ValueError):
            suite.prepare(self.case, self.work)

    def test_missing_output_is_not_pass(self):
        result = suite.check(self.case, self.work)
        self.assertFalse(result["mechanical_ok"])
        self.assertEqual(result["quality_status"], "requires_review")

    def test_input_tampering_is_detected(self):
        doc, path = self.review()
        next((self.work / "inputs").iterdir()).write_text("modified")
        result = suite.score(self.case, self.work, path)
        self.assertFalse(result["pass"])
        self.assertIn("输入文件被更改、删除或新增", result["failures"])

    def test_missing_scores_remain_unreviewed(self):
        _, path = self.review()
        path.write_text(json.dumps(suite.template(self.case)))
        with self.assertRaises(ValueError):
            suite.score(self.case, self.work, path)

    def test_scores_are_weighted_and_critical_gated(self):
        doc, path = self.review()
        self.assertEqual(suite.score(self.case, self.work, path)["quality_score"], 100)
        doc["critical_gates_passed"] = False
        path.write_text(json.dumps(doc))
        result = suite.score(self.case, self.work, path)
        self.assertEqual(result["quality_score"], 100)
        self.assertFalse(result["pass"])

    def test_score_bound_to_exact_artifact(self):
        _, path = self.review()
        (self.work / "output/article.md").write_text("changed")
        with self.assertRaises(ValueError):
            suite.score(self.case, self.work, path)

    def test_symlink_not_followed(self):
        artifact = self.work / "output/article.md"
        artifact.symlink_to(self.work / "PROMPT.md")
        with self.assertRaises(ValueError):
            suite.check(self.case, self.work)

    def test_html_requires_browser_evidence(self):
        self.case = "06-product-html"
        self.work = self.base / "html"
        suite.prepare(self.case, self.work)
        doc, path = self.review(html=True)
        with self.assertRaises(ValueError):
            suite.score(self.case, self.work, path)
        doc.update(browser_checks_completed=True, screenshots=["test-fixture-only.png"])
        path.write_text(json.dumps(doc))
        self.assertEqual(suite.score(self.case, self.work, path)["quality_score"], 100)

    def test_duplicate_dimension_rejected(self):
        doc, path = self.review()
        doc["dimensions"][1]["id"] = "D1"
        path.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            suite.score(self.case, self.work, path)

    def test_count_excludes_code(self):
        self.assertEqual(suite.length_units("中文 hello 123\n```py\nprint('ignore')\n```"), 4)


if __name__ == "__main__":
    unittest.main()
