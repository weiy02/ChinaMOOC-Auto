// ==UserScript==
// @name         中国大学MOOC-自动化
// @namespace    https://github.com/weiy02/ChinaMOOC-Auto
// @version      1.7.3
// @description  中国大学MOOC学生互评自动化：解析真实分值选最高分，评语“科技改变生活”，答题者不可见。支持停止、评分修复；互评功能自动避开答题页，并内置答题页结构探针。
// @author       weiy02
// @match        *://www.icourse163.org/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=icourse163.org
// @license      MIT
// @supportURL   https://github.com/weiy02/ChinaMOOC-Auto/issues
// @homepageURL  https://github.com/weiy02/ChinaMOOC-Auto
// @downloadURL  https://raw.githubusercontent.com/weiy02/ChinaMOOC-Auto/main/main.js
// @updateURL    https://raw.githubusercontent.com/weiy02/ChinaMOOC-Auto/main/main.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ===================== 配置区 =====================
    var CONFIG = {
        COMMENT: '科技改变生活',
        BATCH_COUNT: 10,
        DELAY_AFTER_SUBMIT: 2000,
        DELAY_AFTER_CLICK: 300,
        MAX_ITERATIONS: 200,
        CANCEL_POLL_INTERVAL: 60,
        FIX_MAX_LOOPS: 60,
        FIX_PAGE_WAIT: 2500,
        FIX_LIST_WAIT: 3000,

        // 答题探针自启动：装好网络探针后必须再发生一次导航才能抓到请求，
        // 所以探针要在页面加载时就装好，而不是等用户点了按钮才装。
        QUIZ_PROBE_AUTOSTART: true,

        // ---- 答题 ----
        // 每题之间的随机间隔。固定 300ms 连点二十道题是个很容易被识别的模式。
        QUIZ_DELAY_MIN: 800,
        QUIZ_DELAY_MAX: 2500,
        QUIZ_MAX_ANSWER: 100,
        // 低于这个置信度的命中不采用，算作未解决（并因此阻断自动提交）
        QUIZ_CONFIDENCE_MIN: 0.8,
        // 自动提交默认关，且考试页会硬阻断。改这里只是打开开关，
        // 真正的闸门在 canAutoSubmit() 里。
        QUIZ_AUTO_SUBMIT: false,
    };

    var LIST_CONFIG = {
        // 表格特征词：表格内容包含以下任一词，即视作评分列表
        tableHints: /作业列表|你的评分|学生名|学号|提交时间/,

        // 通用列表结构（非表格时兜底）
        itemSelectors: [
            '.j-list .item',
            '.list-item',
            '.evaluate-list .item',
            '[class*="review-list"] [class*="item"]',
            '[class*="homework-list"] [class*="item"]',
            '[class*="evaluate-list"] [class*="item"]',
            '.m-list .item',
        ],
        scoreSelectors: [
            '.score', '.mark', '.fraction', '.grade',
            '[class*="score"]', '[class*="mark"]', '[class*="fraction"]',
        ],
        enterText: /修改互评|继续互评|进入互评|去互评|开始互评|立即互评|互评|评分|查看/,
        backText: /返回|返回列表|回到列表/,
        completedText: /已完成|已评|已提交|修改互评|继续互评/,
    };

    // 页面路由特征。icourse163 是 hash 路由的单页应用，URL 会随导航变化，
    // 因此每次判定都要重新读 location.href，不能只在启动时判定一次。
    var PAGE_CONFIG = {
        // 考试页：只能提交一次、可能有时限，风险最高，优先识别
        examUrl: /examObject|examIndex|examPaper|\/learn\/exam/i,
        // 答题页：测验 / 单元作业客观题 / 考试
        quizUrl: /quizObject|quizIndex|testObject|\/learn\/quiz|\/learn\/test|homeworkObject|\/learn\/homework/i,
    };

    // 答题页的 DOM 特征。比 URL 可靠：icourse163 的 hash 路由把测验、作业、
    // 已交卷的答案解析都挂在 #/learn/content 下，URL 分不出来。
    function hasQuestionBlocks() {
        return document.querySelectorAll(
            '.u-questionItem, .m-choiceQuestion, .m-subjectiveQuestion, .m-fillblankQuestion, .j-questionItem'
        ).length > 0;
    }

    // ===================== 任务状态 =====================
    var taskState = { running: false, cancelled: false };

    function makeCancelError() {
        var e = new Error('已停止');
        e.__cancelled = true;
        return e;
    }

    function sleep(ms) {
        return new Promise(function (resolve, reject) {
            var start = Date.now();
            function tick() {
                if (taskState.cancelled) { reject(makeCancelError()); return; }
                if (Date.now() - start >= ms) { resolve(); return; }
                setTimeout(tick, CONFIG.CANCEL_POLL_INTERVAL);
            }
            tick();
        });
    }

    async function waitFor(fn, timeoutMs, intervalMs) {
        var start = Date.now();
        var iv = intervalMs || 200;
        while (Date.now() - start < timeoutMs) {
            if (taskState.cancelled) throw makeCancelError();
            try { if (fn()) return true; } catch (e) { /* ignore */ }
            await sleep(iv);
        }
        return false;
    }

    // ===================== 基础工具 =====================
    function isVisible(el) {
        if (!el) return false;
        var s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
        if (el.offsetParent === null && s.position !== 'fixed') return false;
        return true;
    }

    function realClick(el) {
        if (!el) return;
        var types = ['mousedown', 'mouseup', 'click'];
        for (var i = 0; i < types.length; i++) {
            el.dispatchEvent(new MouseEvent(types[i], { bubbles: true, cancelable: true, view: window }));
        }
    }

    function setNativeValue(el, value) {
        if (!el) return;
        var proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        var setter = descriptor ? descriptor.set : null;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ===================== 解除复制限制 =====================
    // 慕课的课件、字幕、题目普遍禁止选中与复制，手段通常是三类：
    //   1. CSS：在 body 或内容容器上设 user-select: none
    //   2. 事件：在 document/body 上挂 copy / cut / selectstart / contextmenu /
    //      dragstart 的处理器，或直接给 on* 属性赋值并 return false
    //   3. 键盘：拦截 Ctrl/⌘ + C / X / A 并 preventDefault
    // 对应两种反制：
    //   - 注入带 !important 的样式表。样式表里的 !important 优先于元素的行内样式，
    //     所以即便站点用 JS 写 body.style.userSelect = 'none' 也压不过它。
    //   - 在 window 的【捕获阶段】掐断事件传播。捕获阶段 window 早于 document，
    //     所以比站点挂在 document 上的捕获监听还早。
    //     关键是只掐传播、不调 preventDefault —— 浏览器的选中/复制/右键菜单等
    //     默认行为必须保留，否则连正常功能一起取消掉了；而站点挂的拦截逻辑
    //     收不到事件，自然也就拦不住。
    var COPY_UNLOCK = {
        STYLE_ID: 'mar-copy-unlock-style',
        KEY: 'mar.copyUnlock',
        EVENTS: ['copy', 'cut', 'paste', 'selectstart', 'contextmenu', 'dragstart'],
    };

    var copyUnlockBound = false;

    function copyUnlockCss() {
        return [
            'html, body, body * {',
            '  -webkit-user-select: text !important;',
            '  -moz-user-select: text !important;',
            '  -ms-user-select: text !important;',
            '  user-select: text !important;',
            '  -webkit-touch-callout: default !important;',
            '}',
            'img, a { -webkit-user-drag: auto !important; }',
        ].join('\n');
    }

    function copyUnlockHandler(e) {
        e.stopImmediatePropagation();
    }

    // 只拦「复制 / 剪切 / 全选」组合键。不这么收窄的话，在 window 捕获阶段
    // 拦掉全部 keydown 会把站点的搜索框和快捷键一起弄坏。
    function copyUnlockKeydown(e) {
        var k = String(e.key || '').toLowerCase();
        if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'x' || k === 'a')) {
            e.stopImmediatePropagation();
        }
    }

    function isCopyUnlockOn() {
        return readStore(COPY_UNLOCK.KEY, false) === true;
    }

    function applyCopyUnlock(on) {
        var existing = document.getElementById(COPY_UNLOCK.STYLE_ID);
        if (on) {
            if (!existing) {
                var style = document.createElement('style');
                style.id = COPY_UNLOCK.STYLE_ID;
                style.textContent = copyUnlockCss();
                (document.head || document.documentElement).appendChild(style);
            }
            if (!copyUnlockBound) {
                for (var i = 0; i < COPY_UNLOCK.EVENTS.length; i++) {
                    window.addEventListener(COPY_UNLOCK.EVENTS[i], copyUnlockHandler, true);
                }
                window.addEventListener('keydown', copyUnlockKeydown, true);
                copyUnlockBound = true;
            }
        } else {
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
            if (copyUnlockBound) {
                for (var j = 0; j < COPY_UNLOCK.EVENTS.length; j++) {
                    window.removeEventListener(COPY_UNLOCK.EVENTS[j], copyUnlockHandler, true);
                }
                window.removeEventListener('keydown', copyUnlockKeydown, true);
                copyUnlockBound = false;
            }
        }
        writeStore(COPY_UNLOCK.KEY, !!on);
    }

    function updateCopyUnlockButton() {
        var btn = document.getElementById('mar-copy-unlock');
        if (!btn) return;
        var on = isCopyUnlockOn();
        btn.textContent = '解除复制限制：' + (on ? '开' : '关');
        if (on) btn.classList.add('mar-on'); else btn.classList.remove('mar-on');
    }

    function toggleCopyUnlock() {
        var next = !isCopyUnlockOn();
        applyCopyUnlock(next);
        updateCopyUnlockButton();
        updateStatus(next
            ? '🔓 已解除复制限制：可选中、可右键、Ctrl/⌘+C 可用'
            : '🔒 已恢复页面原本的复制限制');
    }

    // ===================== 题库：归一化 =====================
    // 用三个归一化器而不是一个：题干的归一化很激进（去光所有空白），
    // 但填空题答案和英文选项套用同样的规则就会永远匹配不上
    // （"New York" 变成 "newyork" 就再也对不上了）。
    var BANK_CONFIG = {
        FUZZY_THRESHOLD: 0.86,     // Dice 阈值
        // Dice 对长度差很敏感：短题干改一个字就掉到 0.83，分不开
        // 「同一道题微调」（重叠系数 ≥0.90）和「另一道相近的题」（≤0.83）。
        // 单独用重叠系数不安全（短题干是长题干子串时会得 1.0），
        // 必须和下面的长度比预筛一起用。
        CONTAINMENT_THRESHOLD: 0.90,
        AMBIGUITY_MARGIN: 0.03,    // 冠亚军分差小于此值即判为歧义，不采纳
        LENGTH_PREFILTER: 0.4,     // 长度差超过此比例直接跳过，不浪费算力
        CANDIDATE_LIMIT: 200,      // 模糊匹配最多精算多少个候选
        OPTION_FUZZY: 0.82,        // 答案文本 → 页面选项 的模糊映射阈值
        SEP: '\u0001',             // 指纹分隔符，正文里不可能出现
    };

    // 全角转半角。（）（）都在 ！-～ 区间内，一并处理
    function toHalfWidth(s) {
        return String(s)
            .replace(/[！-～]/g, function (c) {
                return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
            })
            .replace(/　/g, ' ');
    }

    function unifyQuotes(s) {
        return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    }

    // 题干归一化：全角转半角 → 去题型/分值标记 → 剥题号 → 去光空白 → 小写
    function normalizeStem(text) {
        if (!text) return '';
        var s = unifyQuotes(toHalfWidth(text));
        // 题型/分值标记不是题干的一部分
        s = s.replace(/[【\[][^】\]]{0,10}(?:单选|多选|判断|填空|不定项|简答|论述)[^】\]]{0,10}[】\]]/g, '');
        s = s.replace(/[(]\s*\d+(?:\.\d+)?\s*分\s*[)]/g, '');
        // 题块里的「得分/总分」标签。两侧都要剥，题库里若也混进了它才能对上
        s = s.replace(/得分\s*\/\s*总分/g, '');
        // 题号前缀。必须带分隔符或“第N题”，否则 "2的平方根" 会被削成 "的平方根"
        s = s.replace(/^\s*第\s*\d+\s*[题小]?\s*[.、)）\]】:：]?\s*/, '');
        s = s.replace(/^\s*[(]?\s*\d{1,3}\s*[)）.、:：]\s*/, '');
        s = s.replace(/^\s*\d{1,3}\s+/, '');
        return s.replace(/\s+/g, '').toLowerCase();
    }

    // 选项归一化：只剥“带分隔符”的标号，这样 "3个" / "A类" 不会被误伤
    function normalizeOption(text) {
        if (text === null || text === undefined) return '';
        var s = unifyQuotes(toHalfWidth(text)).replace(/\s+/g, ' ').trim();
        s = s.replace(/^\s*[(]?\s*[A-Za-z]\s*[)）.、:：]\s*/, '');
        s = s.replace(/^\s*\d{1,2}\s*[)）.、:：]\s*/, '');
        return s.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // 答案归一化：保留单个空格，不去光（英文填空答案要保留词间空格）
    function normalizeAnswer(text) {
        if (text === null || text === undefined) return '';
        return unifyQuotes(toHalfWidth(text)).replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // ===================== 题库：相似度 =====================
    function bigrams(s) {
        var out = [];
        if (!s) return out;
        if (s.length === 1) { out.push(s); return out; }
        for (var i = 0; i < s.length - 1; i++) out.push(s.substr(i, 2));
        return out;
    }

    // 二元组多重集合的 Dice 系数：2|A∩B| / (|A|+|B|)
    function diceFromArrays(a, b) {
        if (a.length === 0 && b.length === 0) return 1;
        if (a.length === 0 || b.length === 0) return 0;
        var counts = new Map(), i;
        for (i = 0; i < a.length; i++) counts.set(a[i], (counts.get(a[i]) || 0) + 1);
        var inter = 0;
        for (i = 0; i < b.length; i++) {
            var c = counts.get(b[i]);
            if (c > 0) { inter++; counts.set(b[i], c - 1); }
        }
        return (2 * inter) / (a.length + b.length);
    }

    function diceSimilarity(s1, s2) {
        return diceFromArrays(bigrams(s1), bigrams(s2));
    }

    // 重叠系数 |A∩B| / min(|A|,|B|)，配合长度预筛使用
    function containmentFromArrays(a, b) {
        if (a.length === 0 || b.length === 0) return 0;
        var counts = new Map(), i;
        for (i = 0; i < a.length; i++) counts.set(a[i], (counts.get(a[i]) || 0) + 1);
        var inter = 0;
        for (i = 0; i < b.length; i++) {
            var c = counts.get(b[i]);
            if (c > 0) { inter++; counts.set(b[i], c - 1); }
        }
        return inter / Math.min(a.length, b.length);
    }

    function containmentSimilarity(s1, s2) {
        return containmentFromArrays(bigrams(s1), bigrams(s2));
    }

    // ===================== 题库：索引 =====================
    function mapPush(map, key, val) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(val);
    }

    // 指纹 = 归一化题干 + 选项文本集合（排序后）。
    // 不存哈希：32 位 FNV 在万条量级碰撞率约 1%，且没有便宜的检测手段，
    // 而全长键约 300 字节/条，一万条也就 3MB，还能直接在 console 里看。
    // 归一化后为空的选项（图片选项）要剔除；剩不到 2 个说明选项不可用，
    // 指纹退化成题干本身，这种情况下只允许精确匹配。
    function fingerprintKey(rec) {
        var opts = [], i;
        for (i = 0; i < (rec.o || []).length; i++) {
            var t = normalizeOption(rec.o[i]);
            if (t !== '') opts.push(t);
        }
        if (opts.length < 2) return null;
        return rec._norm + BANK_CONFIG.SEP + opts.slice().sort().join(BANK_CONFIG.SEP);
    }

    function buildBankIndex(records) {
        var idx = {
            byExact: new Map(),
            byFingerprint: new Map(),
            all: [],
            bigramIndex: new Map(),
            stats: { total: 0, noFingerprint: 0 },
        };
        for (var i = 0; i < records.length; i++) {
            var rec = records[i];
            if (!rec || !rec.q) continue;
            rec._norm = normalizeStem(rec.q);
            rec._fpKey = fingerprintKey(rec);
            var pos = idx.all.length;
            idx.all.push(rec);
            mapPush(idx.byExact, rec._norm, rec);
            if (rec._fpKey) mapPush(idx.byFingerprint, rec._fpKey, rec);
            else idx.stats.noFingerprint++;
            // 题干二元组倒排索引：模糊匹配时只对候选集精算，不用每道题扫全库
            var grams = bigrams(rec._norm), seen = {};
            for (var g = 0; g < grams.length; g++) {
                if (seen[grams[g]]) continue;
                seen[grams[g]] = 1;
                if (!idx.bigramIndex.has(grams[g])) idx.bigramIndex.set(grams[g], []);
                idx.bigramIndex.get(grams[g]).push(pos);
            }
        }
        idx.stats.total = idx.all.length;
        return idx;
    }

    // ===================== 题库：匹配 =====================
    function makeFingerprint(normStem, optionTexts) {
        var opts = [], i;
        for (i = 0; i < (optionTexts || []).length; i++) {
            var t = normalizeOption(optionTexts[i]);
            if (t !== '') opts.push(t);
        }
        if (opts.length < 2) return null;
        return normStem + BANK_CONFIG.SEP + opts.slice().sort().join(BANK_CONFIG.SEP);
    }

    function fuzzyMatch(idx, norm) {
        var grams = bigrams(norm);
        if (grams.length === 0) return null;

        var cand = new Map();
        for (var g = 0; g < grams.length; g++) {
            var list = idx.bigramIndex.get(grams[g]);
            if (!list) continue;
            for (var i = 0; i < list.length; i++) cand.set(list[i], (cand.get(list[i]) || 0) + 1);
        }
        if (cand.size === 0) return null;

        // 先按共现次数排序取前 N 个，再精算 Dice：最坏情况下的开销可控
        var arr = [];
        cand.forEach(function (v, k) { arr.push([k, v]); });
        arr.sort(function (a, b) { return b[1] - a[1]; });
        var limit = Math.min(arr.length, BANK_CONFIG.CANDIDATE_LIMIT);

        var scored = [];
        for (var j = 0; j < limit; j++) {
            var rec = idx.all[arr[j][0]];
            var other = rec._norm;
            var maxLen = Math.max(other.length, norm.length);
            if (maxLen === 0) continue;
            if (Math.abs(other.length - norm.length) / maxLen > BANK_CONFIG.LENGTH_PREFILTER) continue;
            var otherGrams = bigrams(other);
            var s = diceFromArrays(grams, otherGrams);
            var c = containmentFromArrays(grams, otherGrams);
            if (s >= BANK_CONFIG.FUZZY_THRESHOLD) {
                scored.push({ rec: rec, score: s, contain: c, via: 'dice' });
            } else if (c >= BANK_CONFIG.CONTAINMENT_THRESHOLD) {
                // Dice 没过但几乎完全重叠：短题干的单字改动属于这种情况
                scored.push({ rec: rec, score: s, contain: c, via: 'containment' });
            }
        }
        if (scored.length === 0) return null;

        scored.sort(function (a, b) { return b.score - a.score; });
        var top = scored[0];
        var second = scored.length > 1 ? scored[1].score : 0;
        // 歧义边距：冠亚军太接近说明题库里有近似重复的题干，宁可不答也不能选错
        if (scored.length > 1 && top.score - second < BANK_CONFIG.AMBIGUITY_MARGIN) {
            return {
                rec: null, source: 'ambiguous', confidence: top.score,
                candidates: scored.slice(0, 3).map(function (x) {
                    return { q: x.rec.q, score: x.score, contain: x.contain, via: x.via };
                })
            };
        }
        return {
            rec: top.rec, source: 'fuzzy', via: top.via,
            // 走重叠系数通道时 Dice 会偏低，报出来吓人，那种情况用重叠系数作置信度
            confidence: (top.via === 'containment') ? top.contain : top.score,
        };
    }

    function answerKey(rec) {
        return (rec.a || []).map(normalizeAnswer).slice().sort().join(BANK_CONFIG.SEP);
    }

    function sameAnswer(recs) {
        var k = answerKey(recs[0]);
        for (var i = 1; i < recs.length; i++) {
            if (answerKey(recs[i]) !== k) return false;
        }
        return true;
    }

    function ambiguous(recs, source, confidence) {
        return {
            rec: null, source: source, confidence: confidence || 1,
            candidates: recs.slice(0, 3).map(function (r) { return { q: r.q, a: r.a, s: r.s, score: 1 }; })
        };
    }

    // 三级匹配：指纹（题干+选项集合）→ 精确（纯题干）→ 模糊
    // 指纹比纯题干更具体，所以优先。命中多条时先看答案是否一致——
    // 一致就放心用，不一致必须判歧义，绝不能静默取第一条。
    function matchQuestion(idx, stem, optionTexts) {
        var norm = normalizeStem(stem);
        if (!norm) return null;

        var fp = makeFingerprint(norm, optionTexts);
        var fh = fp ? idx.byFingerprint.get(fp) : null;
        if (fh && fh.length === 1) return { rec: fh[0], source: 'fingerprint', confidence: 1 };

        var hit = idx.byExact.get(norm);
        if (hit && hit.length === 1) return { rec: hit[0], source: 'exact', confidence: 1 };

        if (hit && hit.length > 1) {
            var narrowed = fh ? hit.filter(function (r) { return r._fpKey === fp; }) : [];
            if (narrowed.length === 1) return { rec: narrowed[0], source: 'exact+fingerprint', confidence: 0.95 };
            if (sameAnswer(hit)) return { rec: hit[0], source: 'exact', confidence: 0.9 };
            return ambiguous(hit, 'ambiguous');
        }
        if (fh && fh.length > 1) {
            if (sameAnswer(fh)) return { rec: fh[0], source: 'fingerprint', confidence: 0.95 };
            return ambiguous(fh, 'ambiguous');
        }
        return fuzzyMatch(idx, norm);
    }

    // ===================== 题库：自检（可脱离平台运行） =====================
    // 这是整个方案里唯一能脱离 icourse163 单测的部分，所以 fixture 要覆盖
    // 已知的全部坑：全角括号、题号前缀、分值后缀、选项乱序、图片选项、
    // 单字题干、英文题干、以及“两条近似题干必须判为歧义”。
    function quizSelfTest() {
        var lines = [];
        function ok(name, cond, detail) {
            lines.push((cond ? '✅ ' : '❌ ') + name + (detail ? '  → ' + detail : ''));
            return cond;
        }

        // --- 归一化 ---
        ok('题号+空格前缀',
            normalizeStem('1 前趋图中的边表示的是什么关系？') === normalizeStem('前趋图中的边表示的是什么关系？'),
            normalizeStem('1 前趋图中的边表示的是什么关系？'));
        ok('题号+句点前缀',
            normalizeStem('2.地球是圆的') === normalizeStem('地球是圆的'));
        ok('“第N题”前缀',
            normalizeStem('第3题 地球是圆的') === normalizeStem('地球是圆的'));
        ok('全角括号分值后缀',
            normalizeStem('地球是圆的（2分）') === normalizeStem('地球是圆的'));
        ok('题型标记剔除',
            normalizeStem('【单选题】地球是圆的') === normalizeStem('地球是圆的'));
        // 站点把「得分/总分」作为独立文本节点放在题块里，不剥掉会让题干对不上
        ok('“得分/总分”标签剔除',
            normalizeStem('地球是圆的 得分/总分') === normalizeStem('地球是圆的'));
        ok('不误伤以数字开头的题干',
            normalizeStem('2的平方根是多少') === normalizeStem('2的平方根是多少') &&
            normalizeStem('2的平方根是多少') !== '');
        ok('选项标号只剥带分隔符的',
            normalizeOption('A. 箭头节点') === '箭头节点' &&
            normalizeOption('A类节点') === 'a类节点' &&
            normalizeOption('3个选项') === '3个选项',
            normalizeOption('A类节点') + ' | ' + normalizeOption('3个选项'));
        ok('答案保留词间空格',
            normalizeAnswer('New York') === 'new york',
            normalizeAnswer('New York'));

        // --- 相似度 ---
        ok('完全相同 = 1', diceSimilarity('地球是圆的', '地球是圆的') === 1);
        ok('完全不同 ≈ 0', diceSimilarity('地球是圆的', 'abcxyz') === 0);
        // 短题干删一个字：Dice 只有 0.833，必须靠重叠系数（0.909）救回来
        var dShort = diceSimilarity('前趋图中的边表示的是什么关系', '前趋图中的边表示什么关系');
        var cShort = containmentSimilarity('前趋图中的边表示的是什么关系', '前趋图中的边表示什么关系');
        ok('短题干单字改动 Dice 偏低而重叠系数偏高',
            dShort < 0.86 && cShort >= 0.90,
            'dice=' + dShort.toFixed(3) + ' contain=' + cShort.toFixed(3));
        // 同义改写两条通道都不该通过，否则会答成另一道题
        var dPara = diceSimilarity('进程和线程的主要区别是什么', '进程和线程的主要区别有哪些');
        var cPara = containmentSimilarity('进程和线程的主要区别是什么', '进程和线程的主要区别有哪些');
        ok('同义改写两条通道都不通过',
            dPara < 0.86 && cPara < 0.90,
            'dice=' + dPara.toFixed(3) + ' contain=' + cPara.toFixed(3));

        // --- 索引与匹配 ---
        var bank = {
            schemaVersion: 1,
            questions: [
                { q: '前趋图中的边表示的是什么关系？', t: 'single',
                  o: ['箭头节点和箭尾节点的包含关系', '箭头节点和箭尾节点的隶属关系',
                      '箭头节点和箭尾节点的并列关系', '箭头节点和箭尾节点的执行次序'],
                  a: ['箭头节点和箭尾节点的执行次序'], s: 'verified' },
                { q: '地球是平的', t: 'judge', o: ['正确', '错误'], a: ['错误'], s: 'verified' },
                { q: '中国的首都是____', t: 'fill', o: [], a: ['北京'], s: 'manual' },
                // 同题干、不同答案（题库里重复且冲突）——必须判歧义，不能静默取第一条
                { q: '进程和线程最主要的区别是什么', t: 'single',
                  o: ['是否拥有独立地址空间', '是否可并发执行'], a: ['是否拥有独立地址空间'], s: 'verified' },
                { q: '进程和线程最主要的区别是什么', t: 'single',
                  o: ['是否拥有独立地址空间', '是否可并发执行'], a: ['是否可并发执行'], s: 'llm' },
            ]
        };
        var idx = buildBankIndex(bank.questions);
        ok('索引条目数', idx.stats.total === 5, String(idx.stats.total));
        ok('填空题无指纹', idx.stats.noFingerprint === 1, String(idx.stats.noFingerprint));

        // 指纹（题干+选项集合）比纯题干更具体，所以它优先于精确匹配，这是设计意图
        var r1 = matchQuestion(idx, '1 前趋图中的边表示的是什么关系？',
            ['箭头节点和箭尾节点的包含关系', '箭头节点和箭尾节点的隶属关系',
             '箭头节点和箭尾节点的并列关系', '箭头节点和箭尾节点的执行次序']);
        ok('首选指纹命中且答案正确',
            r1 && r1.rec && r1.rec.a[0] === '箭头节点和箭尾节点的执行次序',
            r1 ? (r1.source + ' conf=' + r1.confidence) : 'null');

        // 无选项可用时（如只有题干）应退到精确匹配
        var rExact = matchQuestion(idx, '前趋图中的边表示的是什么关系？', []);
        ok('无选项时退到精确匹配',
            rExact && rExact.source === 'exact' && rExact.rec.a[0] === '箭头节点和箭尾节点的执行次序',
            rExact ? rExact.source : 'null');

        // 短题干单字改动 → 必须靠重叠系数通道命中，且要能取到答案
        var rShort = matchQuestion(idx, '1、前趋图中的边表示什么关系？',
            ['箭头节点和箭尾节点的包含关系', '箭头节点和箭尾节点的隶属关系',
             '箭头节点和箭尾节点的并列关系', '箭头节点和箭尾节点的执行次序']);
        ok('短题干单字改动仍能命中',
            rShort && rShort.rec && rShort.rec.a[0] === '箭头节点和箭尾节点的执行次序',
            rShort ? (rShort.source + '/' + rShort.via + ' conf=' + rShort.confidence) : 'null');

        // 选项乱序 + 题干带题号 → 应靠指纹命中
        var shuffled = ['箭头节点和箭尾节点的执行次序', '箭头节点和箭尾节点的并列关系',
                        '箭头节点和箭尾节点的隶属关系', '箭头节点和箭尾节点的包含关系'];
        var r2 = matchQuestion(idx, '1、前趋图中的边表示的是什么关系？', shuffled);
        ok('选项乱序靠指纹命中', r2 && r2.rec && r2.rec.a[0] === '箭头节点和箭尾节点的执行次序',
            r2 ? (r2.source + ' ' + r2.confidence) : 'null');

        var r3 = matchQuestion(idx, '中国的首都是____', []);
        ok('填空题靠精确匹配命中', r3 && r3.rec && r3.rec.a[0] === '北京', r3 ? r3.source : 'null');

        // 题干完全相同但题库里两条答案冲突：必须判歧义
        var r4 = matchQuestion(idx, '进程和线程最主要的区别是什么', ['是否拥有独立地址空间', '是否可并发执行']);
        ok('同题干冲突答案判为歧义',
            r4 && r4.source === 'ambiguous',
            r4 ? (r4.source + ' ' + (r4.candidates ? r4.candidates.length : 0) + '个候选') : 'null');

        // 题干相同且答案一致：可以放心用（题库重复但没冲突不该拖累命中率）
        var dupIdx = buildBankIndex([
            { q: '地球是圆的吗', t: 'judge', o: ['正确', '错误'], a: ['正确'], s: 'verified' },
            { q: '地球是圆的吗', t: 'judge', o: ['正确', '错误'], a: ['正确'], s: 'llm' },
        ]);
        var rDup = matchQuestion(dupIdx, '地球是圆的吗', ['正确', '错误']);
        ok('同题干同答案不判歧义',
            rDup && rDup.rec && rDup.rec.a[0] === '正确',
            rDup ? rDup.source : 'null');

        var r5 = matchQuestion(idx, '完全不相干的一道题呢', ['甲', '乙']);
        ok('无关题目不匹配', !r5, r5 ? r5.source : 'null');

        // --- 指纹不可用时的降级 ---
        var imgIdx = buildBankIndex([
            { q: '看图选择题', t: 'single', o: ['', '', ''], a: [''], s: 'verified' }
        ]);
        ok('图片选项不建指纹', imgIdx.stats.noFingerprint === 1);

        // --- 判断题词表 ---
        ok('判断题真值词表', judgeValue('正确') === true && judgeValue('对') === true && judgeValue('T') === true);
        ok('判断题假值词表', judgeValue('错误') === false && judgeValue('×') === false && judgeValue('否') === false);
        // 子串匹配会把「不正确」里的「正确」当成真值，所以必须整串相等
        ok('“不正确”不被误判为真',
            judgeValue('不正确') === false && judgeValue('不对') === false);
        ok('非判断题选项返回 null', judgeValue('箭头节点') === null && judgeValue('') === null);

        // --- 题库合并：按来源可信度取胜，而不是按写入顺序 ---
        var mA = [{ q: '地球是圆的吗', t: 'judge', o: ['正确', '错误'], a: ['正确'], s: 'llm' }];
        var mB = [{ q: '地球是圆的吗', t: 'judge', o: ['正确', '错误'], a: ['错误'], s: 'verified' }];
        var merged = mergeRecords([mA, mB]);
        ok('冲突时高可信度胜出',
            merged.records.length === 1 && merged.records[0].a[0] === '错误',
            JSON.stringify(merged.records[0].a) + ' from ' + merged.records[0].s);
        ok('冲突被记录下来', merged.conflicts.length === 1, String(merged.conflicts.length));
        var merged2 = mergeRecords([mB, mA]);
        ok('合并结果与写入顺序无关',
            merged2.records.length === 1 && merged2.records[0].a[0] === '错误',
            JSON.stringify(merged2.records[0].a));

        // --- 演练规划：安全属性的核心测试 ---
        function fakeQ(type, texts) {
            return {
                type: type,
                options: texts.map(function (t, i) {
                    return {
                        letter: String.fromCharCode(65 + i), text: t,
                        input: { type: type === 'multi' ? 'checkbox' : 'radio', checked: false }
                    };
                })
            };
        }
        var mSingle = {
            rec: { q: 'x', t: 'single', o: ['甲', '乙', '丙'], a: ['丙'], s: 'verified' },
            source: 'exact', confidence: 1
        };
        var p1 = planQuestion(fakeQ('single', ['甲', '乙', '丙']), mSingle);
        ok('答案能映射时给出要选的项',
            p1.action === 'answer' && p1.picks.length === 1 && p1.picks[0].letter === 'C',
            formatPicks(p1.picks));
        // 契约定死：picks 必须是选项对象，作答要靠它重新定位 DOM 节点。
        // 曾经这里是格式化好的字符串，结果 answerOne 一个选项都点不中，
        // 而三个单元测试因为手写的 picks 是对象而全部通过——只有端到端测试抓到了。
        ok('picks 是选项对象而非格式化字符串',
            p1.picks[0] && typeof p1.picks[0] === 'object' && typeof p1.picks[0].text === 'string',
            typeof p1.picks[0]);
        // 页面选项和题库不一致 → 必须放弃，绝不能回退成「按索引选第 3 个」
        var p2 = planQuestion(fakeQ('single', ['甲', '乙', '丁']), mSingle);
        ok('答案映射不到页面选项时放弃', p2.action === 'pending', p2.reason);
        var p3 = planQuestion(fakeQ('single', ['甲', '乙', '丙']), {
            rec: { q: 'x', t: 'multi', o: ['甲'], a: ['甲'], s: 'verified' }, source: 'exact', confidence: 1
        });
        ok('题型不一致时放弃', p3.action === 'pending' && p3.reason.indexOf('题型不一致') !== -1, p3.reason);

        var mMulti = {
            rec: { q: 'x', t: 'multi', o: ['甲', '乙', '丙'], a: ['甲', '丙'], s: 'verified' },
            source: 'exact', confidence: 1
        };
        var pm = planQuestion(fakeQ('multi', ['甲', '乙', '丙']), mMulti);
        ok('多选题映射多个选项', pm.action === 'answer' && pm.picks.length === 2, JSON.stringify(pm.picks));
        // 多选题只映射到一半也必须整题放弃，不能只勾一半去交
        var pm2 = planQuestion(fakeQ('multi', ['甲', '乙', '戊']), mMulti);
        ok('多选题部分映射成功也放弃', pm2.action === 'pending', pm2.reason);

        var p4 = planQuestion({ type: 'unsupported', options: [] }, null);
        ok('不支持的题型被显式跳过', p4.action === 'skip', p4.reason);
        var p5 = planQuestion(fakeQ('single', ['甲', '乙']), { rec: null, source: 'ambiguous', candidates: [] });
        ok('歧义命中不当作未命中处理',
            p5.action === 'pending' && p5.reason.indexOf('歧义') !== -1, p5.reason);

        var passed = lines.filter(function (l) { return l.indexOf('✅') === 0; }).length;
        var summary = '自检 ' + passed + '/' + lines.length + ' 通过';
        console.log('[MOOC答题自检]\n' + lines.join('\n'));
        updateStatus((passed === lines.length ? '✅ ' : '⚠️ ') + summary);
        return { summary: summary, lines: lines };
    }

    // ===================== 答题：页面解析 =====================
    var QUIZ = {
        item: '.u-questionItem',
        choices: 'ul.choices > li',
        optionPos: '.optionPos',
        optionCnt: '.optionCnt',
        iconTrue: '.u-icon-correct',
        iconFalse: '.u-icon-wrong',
        submitBtn: 'a.submit.j-submit, .j-submit',
        replayBtn: 'a.submit.j-replay, .j-replay',
    };

    // 判断题的选项结构（已在页面上确证）：
    //   <div class="optionCnt"><span class="u-icon-correct">::before</span></div>
    // ✓ / ✗ 是【伪元素】渲染的图标字体，既不是文字节点也不是图片。
    // 所以只有两条路可走，而只有一条可行：
    //   - 读 textContent        → 空
    //   - 读 ::before 的 content → "" 这种码点，读不出「正确」二字
    //   - 读 class               → ✅ 唯一可行的
    //
    // 另必须说清楚：【这】u-icon-correct / u-icon-wrong 是选项内容本身（✓ 和 ✗），
    // 不是答案标记。依据是已交卷页面：A 带 u-icon-correct、B 带 u-icon-wrong，
    // 而页面同时写着「正确答案：B 你选对了」且 B 的 input 是 checked ——
    // 若 ✓/✗ 是答案标记，正确答案不可能落在 ✗ 那一侧。
    // 好处是含义直接编码在 class 里，不必依赖「A=正确」这种位置约定。
    var JUDGE_TRUE_WORDS = ['正确', '对', '√', '✓', '✔', '是', 't', 'true', 'y', 'yes'];
    var JUDGE_FALSE_WORDS = ['错误', '错', '×', '✕', '✗', '否', 'f', 'false', 'n', 'no', '不对', '不正确'];

    function judgeValue(text) {
        var t = normalizeOption(text);
        if (!t) return null;
        if (JUDGE_TRUE_WORDS.indexOf(t) !== -1) return true;
        if (JUDGE_FALSE_WORDS.indexOf(t) !== -1) return false;
        return null;
    }

    // 从类名语义推断图标含义。先判「错」再判「对」，否则 incorrect / 不对
    // 这类含 correct 字样的类名会被误判成真值。
    function iconClassJudge(cls) {
        if (!cls) return null;
        if (/incorrect|wrong|error|false/i.test(cls)) return false;
        if (/correct|right|true/i.test(cls)) return true;
        return null;
    }

    // 取选项里图标 span 的类名。已知类名优先；未知类名时取内部第一个 span，
    // 供演练报告展示，方便别的课程用了不同命名时一眼看出问题。
    function readOptionIconClass(li) {
        var cnt = li.querySelector(QUIZ.optionCnt) || li;
        var marked = cnt.querySelector(QUIZ.iconTrue) || cnt.querySelector(QUIZ.iconFalse);
        if (marked) return String(marked.className || '');
        var span = cnt.querySelector('span');
        if (!span) return '';
        return (typeof span.className === 'string') ? span.className : '';
    }

    // 读一个选项的正文。文字优先；没有文字时看是不是判断题的 ✓/✗ 图标。
    function readOptionText(li) {
        var cnt = li.querySelector(QUIZ.optionCnt);
        var raw = cnt ? (cnt.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (raw) return raw;
        var v = iconClassJudge(readOptionIconClass(li));
        if (v !== null) return v ? '正确' : '错误';
        return '';
    }

    function readOptionLetter(li) {
        var pos = li.querySelector(QUIZ.optionPos);
        if (!pos) return '';
        return (pos.textContent || '').replace(/[\s.、)）:：]/g, '');
    }

    // 题型判定。识别不了的题型必须显式标成 unsupported 并在演练里报出来，
    // 否则「未解决计数」是错的，自动提交要么带着空题交、要么卡死。
    // 目前未覆盖：不定项选择、连线/匹配、排序、共用词库的完形填空、填空/简答。
    function classifyQuestion(options) {
        if (options.length === 0) return 'unsupported';
        var input = options[0].input;
        if (!input) return 'unsupported';
        var t = String(input.type || '').toLowerCase();
        if (t === 'checkbox') return 'multi';
        if (t === 'radio') {
            if (options.length === 2) {
                var a = judgeValue(options[0].text);
                var b = judgeValue(options[1].text);
                // 两个选项分属真/假两类且不重叠，才敢当判断题处理
                if (a !== null && b !== null && a !== b) return 'judge';
            }
            return 'single';
        }
        return 'unsupported';
    }

    // 扫描页面题目。结构见计划文件里 Phase 0 的探测结果。
    function scanQuestions() {
        var items = document.querySelectorAll(QUIZ.item);
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            // 站点自带的智能助教浮层里也有富文本，别把它算成题目
            if (isAssistantNode(item)) continue;

            var lis = item.querySelectorAll(QUIZ.choices);
            var options = [];
            for (var L = 0; L < lis.length; L++) {
                options.push({
                    el: lis[L],
                    input: lis[L].querySelector('input'),
                    letter: readOptionLetter(lis[L]),
                    text: readOptionText(lis[L]),
                    iconCls: readOptionIconClass(lis[L]),
                });
            }
            var cls = String(item.className || '');
            out.push({
                el: item,
                index: out.length,
                mode: /examMode/.test(cls) ? 'exam'
                    : (/analysisMode/.test(cls) ? 'analysis' : 'normal'),
                stem: extractStemGuess(item),
                options: options,
                type: classifyQuestion(options),
                answeredBy: (function (opts) {
                    var picked = [];
                    for (var k = 0; k < opts.length; k++) {
                        if (opts[k].input && opts[k].input.checked) picked.push(opts[k].letter || String(k));
                    }
                    return picked;
                })(options),
            });
        }
        return out;
    }

    // 页面上能否重做（决定试错学习是否可行，以及自动提交敢不敢开）
    function hasReplayEntry() {
        var btn = document.querySelector(QUIZ.replayBtn);
        return !!(btn && isVisible(btn));
    }

    // ===================== 答题：题库存取 =====================
    // 目前只有 localStorage 一条来源。远程 JSON 拉取是 Phase 5，
    // 现在先用「粘贴导入」把整条流水线跑通，不引网络依赖。
    var STORE_KEYS = {
        imported: 'mar.bank.imported',
        learned: 'mar.bank.learned',
    };

    function readStore(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[MOOC答题] 读取本地存储失败', key, e);
            return fallback;
        }
    }

    function writeStore(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            return true;
        } catch (e) {
            console.warn('[MOOC答题] 写入本地存储失败', key, e);
            return false;
        }
    }

    // 导入的题库 + 本地累积的题合并。同题冲突按来源可信度取高的，
    // 而不是按「谁写在后面」——否则一条 llm 记录会盖掉 verified。
    var SOURCE_RANK = { scraped: 4, verified: 3, manual: 2, llm: 1 };

    function rankOf(s) {
        return SOURCE_RANK[s] || 0;
    }

    function mergeRecords(lists) {
        var byKey = new Map(), conflicts = [];
        for (var i = 0; i < lists.length; i++) {
            var recs = lists[i] || [];
            for (var j = 0; j < recs.length; j++) {
                var rec = recs[j];
                if (!rec || !rec.q) continue;
                var key = normalizeStem(rec.q) + BANK_CONFIG.SEP +
                    (rec.o || []).map(normalizeOption).slice().sort().join(BANK_CONFIG.SEP);
                var prev = byKey.get(key);
                if (!prev) { byKey.set(key, rec); continue; }
                var winner = rankOf(rec.s) > rankOf(prev.s) ? rec : prev;
                var loser = winner === rec ? prev : rec;
                byKey.set(key, winner);
                if (answerKey(winner) !== answerKey(loser)) {
                    conflicts.push({ q: winner.q, kept: winner.a, keptFrom: winner.s, dropped: loser.a, droppedFrom: loser.s });
                }
            }
        }
        var out = [];
        byKey.forEach(function (v) { out.push(v); });
        return { records: out, conflicts: conflicts };
    }

    function getBankRecords() {
        var imported = readStore(STORE_KEYS.imported, []);
        var learned = readStore(STORE_KEYS.learned, []);
        var merged = mergeRecords([imported.questions || imported, learned]);
        if (merged.conflicts.length) {
            console.warn('[MOOC答题] 题库存在冲突记录', merged.conflicts);
        }
        return merged;
    }

    // ===================== 答题：只读演练 =====================
    // 不点击任何东西。目的是在真正作答之前，把「会选哪个」摊开给人看。
    function planQuestion(q, match) {
        if (q.type === 'unsupported') {
            return { action: 'skip', reason: '题型不支持（' + q.options.length + ' 个选项）' };
        }
        if (!match || !match.rec) {
            if (match && match.source === 'ambiguous') {
                return { action: 'pending', reason: '题库里有多条冲突记录，判为歧义' };
            }
            return { action: 'pending', reason: '题库未命中' };
        }
        var rec = match.rec;

        // 同一题里出现重复的选项正文时，按文本定位会张冠李戴（分不清该点哪一个）
        var seen = {}, dup = false;
        for (var z = 0; z < q.options.length; z++) {
            var okey = normalizeOption(q.options[z].text);
            if (!okey) continue;
            if (seen[okey]) { dup = true; break; }
            seen[okey] = 1;
        }
        if (dup) return { action: 'pending', reason: '该题存在重复的选项正文，无法按文本定位' };

        // 题型必须一致，不一致宁可不用
        if (rec.t && q.type !== 'judge' && rec.t !== q.type) {
            return { action: 'pending', reason: '题型不一致（题库 ' + rec.t + ' / 页面 ' + q.type + '）' };
        }

        var picks = [], miss = [];
        for (var i = 0; i < (rec.a || []).length; i++) {
            var want = normalizeAnswer(rec.a[i]);
            var found = null;
            for (var k = 0; k < q.options.length; k++) {
                if (normalizeOption(q.options[k].text) === want) { found = q.options[k]; break; }
            }
            if (found) picks.push(found);
            else miss.push(rec.a[i]);
        }
        // 任一答案文本映射不到页面选项 → 整题放弃，绝不回退到「按索引选第 N 个」
        if (miss.length > 0 || picks.length === 0) {
            return {
                action: 'pending',
                reason: '答案文本映射不到页面选项：' + miss.map(function (m) { return JSON.stringify(m); }).join('、')
            };
        }
        return {
            action: 'answer',
            source: match.source,
            confidence: match.confidence,
            // 返回选项对象而不是格式化字符串：作答时要拿它重新定位 DOM 节点。
            // 展示用的字符串由 formatPicks() 生成。
            picks: picks,
        };
    }

    function formatPicks(picks) {
        var out = [];
        for (var i = 0; i < (picks || []).length; i++) {
            out.push((picks[i].letter || '?') + '. ' + picks[i].text);
        }
        return out.join(' | ');
    }

    function runQuizDryRun() {
        var questions = scanQuestions();
        if (questions.length === 0) {
            updateStatus('❌ 本页未识别到题目块（' + QUIZ.item + '）');
            return;
        }
        var bank = getBankRecords();
        if (bank.records.length === 0) {
            updateStatus('⚠️ 题库为空，请先用「导入题库」粘贴 JSON；本次只报告页面解析结果');
        }
        var idx = buildBankIndex(bank.records);

        var lines = [];
        lines.push('页面: ' + location.href);
        lines.push('题目: ' + questions.length + ' 道    题库: ' + bank.records.length + ' 条'
            + (bank.conflicts.length ? '（存在 ' + bank.conflicts.length + ' 条冲突）' : ''));
        lines.push('可重做: ' + (hasReplayEntry() ? '是' : '否/未检测到'));
        lines.push('');

        var stat = { answer: 0, pending: 0, skip: 0 };
        for (var i = 0; i < questions.length; i++) {
            var q = questions[i];
            var match = q.type === 'unsupported' ? null
                : matchQuestion(idx, q.stem, q.options.map(function (o) { return o.text; }));
            var plan = planQuestion(q, match);
            stat[plan.action]++;

            var head = (i + 1) + '. [' + q.type + '/' + q.mode + '] ';
            if (plan.action === 'answer') {
                lines.push(head + '✅ 会选 → ' + formatPicks(plan.picks)
                    + '   （' + plan.source + ' conf=' + (plan.confidence || 0).toFixed(3) + '）');
            } else if (plan.action === 'pending') {
                lines.push(head + '❓ 未解决 → ' + plan.reason);
            } else {
                lines.push(head + '⏭ 跳过 → ' + plan.reason);
            }
            lines.push('   题干: ' + q.stem.slice(0, 70));
            var optLine = [];
            for (var o = 0; o < q.options.length; o++) {
                var op = q.options[o];
                var label = op.text;
                // 正文为空时把图标类名带出来——别的课程若用了不同命名，这里一眼能看见
                if (!label) label = op.iconCls ? ('(图标 ' + op.iconCls + ')') : '(空)';
                optLine.push(op.letter + '.' + label);
            }
            lines.push('   选项: ' + optLine.join(' | ').slice(0, 150));
            if (match && match.candidates) {
                for (var c = 0; c < match.candidates.length; c++) {
                    var cd = match.candidates[c];
                    var sc = (typeof cd.score === 'number') ? (' conf=' + cd.score.toFixed(3)) : '';
                    lines.push('      候选' + (c + 1) + ': ' + String(cd.q).slice(0, 40)
                        + sc + '  答案=' + JSON.stringify(cd.a || []).slice(0, 40)
                        + (cd.s ? '  来源=' + cd.s : ''));
                }
            }
            lines.push('');
        }
        lines.push('=== 汇总：会作答 ' + stat.answer + ' 道，未解决 ' + stat.pending + ' 道，跳过 ' + stat.skip + ' 道 ===');

        var text = lines.join('\n');
        console.log('[MOOC答题演练]\n' + text);
        showTextOverlay('只读演练 · 不会点击任何选项', text);
        updateStatus('🔎 演练完成：会作答 ' + stat.answer + ' 道，未解决 ' + stat.pending + ' 道，跳过 ' + stat.skip + ' 道（未做任何操作）');
    }

    // ===================== 答题：作答 =====================
    // 每题之间的间隔是随机的。固定 300ms 连点二十道题是个很容易被识别的模式，
    // 考试场景还可能有防作弊在看节奏。
    function quizPace() {
        var lo = CONFIG.QUIZ_DELAY_MIN, hi = CONFIG.QUIZ_DELAY_MAX;
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    }

    // 复选框要显式设定目标状态，不能无条件 toggle —— 重复进入同一页会把已选中的反选掉
    function ensureChecked(input, want) {
        if (!input) return false;
        if (!!input.checked !== !!want) realClick(input);
        // 点完再验一次：有的站点会用自己的逻辑接管点击
        if (!!input.checked !== !!want) {
            input.checked = !!want;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return !!input.checked === !!want;
    }

    // SPA 会重渲染，匹配时拿到的元素引用到点击时可能已经失效——轻则静默点空，
    // 重则点到被复用的节点上。所以每次点击前都从题目容器重新解析一遍，
    // 断言归一化文本仍与计划一致，不一致就重解析。
    function reResolveOption(q, pick) {
        var want = normalizeOption(pick.text);
        var lis = q.el.querySelectorAll(QUIZ.choices);
        for (var i = 0; i < lis.length; i++) {
            if (normalizeOption(readOptionText(lis[i])) === want) {
                return { el: lis[i], input: lis[i].querySelector('input') };
            }
        }
        return null;
    }

    function markUncertain(q, reason) {
        if (!q.el) return;
        q.el.classList.add('mar-uncertain');
        try { q.el.setAttribute('title', '未作答：' + reason); } catch (e) { /* ignore */ }
    }

    async function answerOne(q, plan) {
        var done = 0, failed = [];
        var want = {}, i;

        for (i = 0; i < plan.picks.length; i++) {
            want[normalizeOption(plan.picks[i].text)] = 1;
        }

        // 多选题：先把不该选的摘掉。radio 天然互斥（点新的会自动取消旧的），
        // 但 checkbox 没有这个行为——页面里遗留的勾会被一起提交，静默多选错项。
        if (q.type === 'multi') {
            var lis = q.el.querySelectorAll(QUIZ.choices);
            for (var d = 0; d < lis.length; d++) {
                var cb = lis[d].querySelector('input');
                if (!cb || String(cb.type || '').toLowerCase() !== 'checkbox') continue;
                if (want[normalizeOption(readOptionText(lis[d]))]) continue;
                if (cb.checked) {
                    ensureChecked(cb, false);
                    await sleep(quizPace());
                }
            }
        }

        for (i = 0; i < plan.picks.length; i++) {
            var fresh = reResolveOption(q, plan.picks[i]);
            if (!fresh || !fresh.input) { failed.push(plan.picks[i].text); continue; }
            var ok;
            if (String(fresh.input.type || '').toLowerCase() === 'checkbox') {
                ok = ensureChecked(fresh.input, true);
            } else {
                selectRadio(fresh.input);
                ok = !!fresh.input.checked;
            }
            if (ok) done++; else failed.push(plan.picks[i].text);
            await sleep(quizPace());
        }
        return { done: done, failed: failed };
    }

    // ---- 自动提交开关 ----
    // 这是用户可切换的开关，但真正的安全闸门在 canAutoSubmit() 里：
    // 光把开关打开还不够，未解决题目数和页面类型都会再拦一道。
    var AUTOSUBMIT_KEY = 'mar.quizAutoSubmit';

    function isAutoSubmitOn() {
        return readStore(AUTOSUBMIT_KEY, CONFIG.QUIZ_AUTO_SUBMIT) === true;
    }

    function updateAutoSubmitButton() {
        var btn = document.getElementById('mar-quiz-autosubmit');
        if (!btn) return;
        var on = isAutoSubmitOn();
        btn.textContent = '自动提交：' + (on ? '开' : '关');
        if (on) btn.classList.add('mar-on'); else btn.classList.remove('mar-on');
    }

    function toggleAutoSubmit() {
        var next = !isAutoSubmitOn();
        writeStore(AUTOSUBMIT_KEY, next);
        updateAutoSubmitButton();
        updateTabAlert();
        if (next && detectPageType() === 'exam') {
            updateStatus('⚠️ 自动提交开关已打开，但当前是考试页——仍会被硬阻断（只能提交一次，不替你冒这个险）');
        } else {
            updateStatus(next
                ? '自动提交：开（但只要还有未解决的题目就不会提交）'
                : '自动提交：关。作答完会红框标出未解决的题，由你检查后手动提交');
        }
    }

    // 自动提交的三道闸门，任一条不满足就只作答、把提交留给人
    function canAutoSubmit(unresolvedCount) {
        if (!isAutoSubmitOn()) return { ok: false, why: '自动提交开关是关的' };
        if (detectPageType() === 'exam') {
            return { ok: false, why: '考试页硬阻断自动提交（只能提交一次，失误无法挽回）' };
        }
        if (unresolvedCount > 0) {
            return { ok: false, why: '还有 ' + unresolvedCount + ' 道题未解决' };
        }
        return { ok: true };
    }

    function getQuizSubmitButton() {
        var btn = document.querySelector(QUIZ.submitBtn);
        if (btn && isVisible(btn) && !btn.disabled) return btn;
        return null;
    }

    async function runQuizAnswer() {
        var questions = scanQuestions();
        if (questions.length === 0) { updateStatus('❌ 本页未识别到题目'); return; }

        var bank = getBankRecords();
        var idx = buildBankIndex(bank.records);

        var oldMarks = document.querySelectorAll('.mar-uncertain');
        for (var m = 0; m < oldMarks.length; m++) oldMarks[m].classList.remove('mar-uncertain');

        var answered = 0, unresolved = 0, skipped = 0;
        var limit = Math.min(questions.length, CONFIG.QUIZ_MAX_ANSWER);

        for (var i = 0; i < limit; i++) {
            if (taskState.cancelled) throw makeCancelError();
            var q = questions[i];

            if (q.type === 'unsupported') {
                skipped++;
                markUncertain(q, '题型暂不支持');
                continue;
            }
            var match = matchQuestion(idx, q.stem, q.options.map(function (o) { return o.text; }));
            var plan = planQuestion(q, match);
            if (plan.action !== 'answer') {
                unresolved++;
                markUncertain(q, plan.reason);
                continue;
            }
            if (plan.confidence < CONFIG.QUIZ_CONFIDENCE_MIN) {
                unresolved++;
                markUncertain(q, '置信度 ' + plan.confidence.toFixed(2) + ' 低于阈值 ' + CONFIG.QUIZ_CONFIDENCE_MIN);
                continue;
            }

            updateStatus('作答中... ' + (i + 1) + '/' + limit);
            var r = await answerOne(q, plan);
            if (r.failed.length > 0) {
                unresolved++;
                markUncertain(q, '有选项点击失败：' + r.failed.join('、'));
            } else {
                answered++;
            }
        }

        var gate = canAutoSubmit(unresolved);
        var summary = '已作答 ' + answered + ' 题，未解决 ' + unresolved + ' 题'
            + (skipped ? '，跳过 ' + skipped + ' 题（题型不支持）' : '');

        if (gate.ok) {
            var btn = getQuizSubmitButton();
            if (!btn) {
                updateStatus('⚠️ ' + summary + '；未找到可见的提交按钮，请手动提交');
                return;
            }
            updateStatus('⏳ ' + summary + '，正在提交...');
            realClick(btn);
            await sleep(CONFIG.DELAY_AFTER_SUBMIT);
            await dismissModal();
            updateStatus('✅ ' + summary + '，已提交');
        } else {
            // 红框标出未解决的题，让人一眼看到该补哪几道
            updateStatus('📝 ' + summary + '；未自动提交（' + gate.why + '），请检查后手动提交');
        }
    }

    function importBankPrompt() {
        var cur = readStore(STORE_KEYS.imported, null);
        showTextOverlay(
            '导入题库 · 粘贴 JSON 后点保存',
            cur ? JSON.stringify(cur, null, 2) : '{\n  "schemaVersion": 1,\n  "questions": [\n    { "q": "题干原文", "t": "single", "o": ["选项A","选项B"], "a": ["选项A"], "s": "verified" }\n  ]\n}',
            function (val) {
                var parsed;
                try {
                    parsed = JSON.parse(val);
                } catch (e) {
                    updateStatus('❌ JSON 解析失败：' + e.message);
                    return;
                }
                var recs = parsed.questions || parsed;
                if (!(recs instanceof Array)) {
                    updateStatus('❌ 格式不对：应为 {schemaVersion, questions:[...]} 或直接是题目数组');
                    return;
                }
                writeStore(STORE_KEYS.imported, { schemaVersion: parsed.schemaVersion || 1, questions: recs });
                var check = getBankRecords();
                updateStatus('✅ 已导入 ' + recs.length + ' 条题目'
                    + (check.conflicts.length ? '，其中 ' + check.conflicts.length + ' 条存在答案冲突' : ''));
                console.log('[MOOC答题] 导入后的题库', check);
            }
        );
    }

    // ===================== 页面类型判定 =====================
    // 互评逻辑在答题页上是危险的：rateCurrentAssignment 会把页面上所有 radio 按
    // “分值最高”分组选中——在测验页那就是错答案，紧接着 submitCurrent 会把它提交。
    // 因此互评只在【明确解析出评分列表、且不在答题路由上】时才允许运行：宁可漏跑，不可误跑。
    function detectPageType() {
        var href = location.href;
        if (PAGE_CONFIG.examUrl.test(href)) return 'exam';
        if (PAGE_CONFIG.quizUrl.test(href)) return 'quiz';
        // URL 分不出来时靠 DOM 兜底：测验、单元作业、已交卷的答案解析都挂在
        // #/learn/content 下，光看 URL 全是同一个路由。
        if (hasQuestionBlocks()) return 'question';
        return 'unknown';
    }

    function assertReviewPage() {
        var type = detectPageType();
        if (type === 'quiz' || type === 'exam' || type === 'question') {
            updateStatus('⚠️ 当前是答题页面，互评功能已禁用（避免把题目选项当成分数选中）');
            return false;
        }
        var list = parseScoreList();
        if (!list || list.items.length === 0) {
            updateStatus('⚠️ 未检测到互评列表，互评功能不在此页面运行');
            return false;
        }
        return true;
    }

    // ===================== 分值解析 =====================
    function parseScoreFromText(text) {
        if (!text) return null;
        var m = text.match(/(\d+(?:\.\d+)?)\s*分/);
        if (m) return parseFloat(m[1]);
        m = text.match(/^(\d+(?:\.\d+)?)$/);
        if (m) return parseFloat(m[1]);
        m = text.match(/(\d+(?:\.\d+)?)/);
        if (m) return parseFloat(m[1]);
        return null;
    }

    function getScoreFromRadio(r) {
        var lbl = r.closest('label');
        if (!lbl && r.id) {
            try { lbl = document.querySelector('label[for="' + CSS.escape(r.id) + '"]'); }
            catch (e) { lbl = null; }
        }
        if (lbl) { var s1 = parseScoreFromText(lbl.textContent); if (s1 !== null && !isNaN(s1)) return s1; }
        if (r.parentElement) { var s2 = parseScoreFromText(r.parentElement.textContent); if (s2 !== null && !isNaN(s2)) return s2; }
        var attrs = ['data-score', 'data-value', 'data-val'];
        for (var i = 0; i < attrs.length; i++) {
            var v = r.getAttribute(attrs[i]);
            if (v) { var n = parseFloat(v); if (!isNaN(n)) return n; }
        }
        if (r.value) { var nv = parseFloat(r.value); if (!isNaN(nv)) return nv; }
        return null;
    }

    function getScoreFromElement(el) {
        if (!el) return null;
        var attrs = ['data-score', 'data-value', 'data-val'];
        for (var i = 0; i < attrs.length; i++) {
            var v = el.getAttribute ? el.getAttribute(attrs[i]) : null;
            if (v) { var n = parseFloat(v); if (!isNaN(n)) return n; }
        }
        if (el.querySelector) {
            var inner = el.querySelector('input');
            if (inner && inner.value) { var ni = parseFloat(inner.value); if (!isNaN(ni)) return ni; }
        }
        var s1 = parseScoreFromText((el.textContent || '').trim());
        if (s1 !== null && !isNaN(s1)) return s1;
        if (el.parentElement) { var s2 = parseScoreFromText(el.parentElement.textContent || ''); if (s2 !== null && !isNaN(s2)) return s2; }
        return null;
    }

    function selectRadio(r) {
        realClick(r);
        if (!r.checked) {
            r.checked = true;
            r.dispatchEvent(new Event('input', { bubbles: true }));
            r.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // ===================== 提交按钮 / 完成判定 =====================
    function getVisibleSubmitButton() {
        var candidates = document.querySelectorAll('.j-submitbtn, .submit-btn, button[class*="submit"]');
        for (var i = 0; i < candidates.length; i++) {
            if (isVisible(candidates[i]) && !candidates[i].disabled) return candidates[i];
        }
        var allBtns = document.querySelectorAll('button, a, div[role="button"]');
        for (var j = 0; j < allBtns.length; j++) {
            if (!isVisible(allBtns[j]) || allBtns[j].disabled) continue;
            var t = (allBtns[j].textContent || '').trim();
            if (t === '提交' || t === '提交互评') return allBtns[j];
        }
        return null;
    }

    function isFinished() {
        if (getVisibleSubmitButton()) return false;
        if (document.querySelectorAll('input[type="radio"]').length > 0) return false;
        return true;
    }

    // ===================== 评分主逻辑 =====================
    async function rateCurrentAssignment() {
        var rated = 0;

        var allRadios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"]'));
        if (allRadios.length > 0) {
            var groups = new Map();
            allRadios.forEach(function (r) {
                var key = r.name || '__ungrouped__';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(r);
            });
            var it = groups.values(), g = it.next();
            while (!g.done) {
                var group = g.value, best = null, bestScore = -Infinity;
                for (var i = 0; i < group.length; i++) {
                    var s = getScoreFromRadio(group[i]);
                    if (s !== null && !isNaN(s) && s > bestScore) { bestScore = s; best = group[i]; }
                }
                if (!best && group.length > 0) best = group[group.length - 1];
                if (best) { selectRadio(best); rated++; await sleep(CONFIG.DELAY_AFTER_CLICK); }
                g = it.next();
            }
        }

        if (rated === 0) {
            var areas = Array.prototype.slice.call(document.querySelectorAll('.s'));
            if (areas.length === 0) {
                areas = Array.prototype.slice.call(document.querySelectorAll('[class*="score"], [class*="rating"]'));
            }
            if (areas.length === 0) return { success: false, error: '未找到评分区域，请确认已进入互评页面' };

            for (var a = 0; a < areas.length; a++) {
                var area = areas[a];
                var options = Array.prototype.slice.call(area.querySelectorAll('label, .option, [role="radio"]'));
                if (options.length === 0) {
                    options = Array.prototype.slice.call(area.querySelectorAll('span, div'))
                        .filter(function (el) { return el.children.length === 0 && /\d/.test(el.textContent || ''); });
                }
                options = options.filter(function (el) {
                    return !options.some(function (other) { return other !== el && other.contains(el); });
                });
                var bestOpt = null, bestOptScore = -Infinity;
                for (var k = 0; k < options.length; k++) {
                    var os = getScoreFromElement(options[k]);
                    if (os !== null && !isNaN(os) && os > bestOptScore) { bestOptScore = os; bestOpt = options[k]; }
                }
                if (!bestOpt && options.length > 0) bestOpt = options[options.length - 1];
                if (bestOpt) { realClick(bestOpt); rated++; await sleep(CONFIG.DELAY_AFTER_CLICK); }
            }
        }

        if (rated === 0) return { success: false, error: '未找到任何可评分选项' };

        var textareas = document.querySelectorAll('textarea');
        for (var t = 0; t < textareas.length; t++) {
            if (isVisible(textareas[t])) {
                setNativeValue(textareas[t], CONFIG.COMMENT);
                await sleep(CONFIG.DELAY_AFTER_CLICK);
            }
        }

        var checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (var c = 0; c < checkboxes.length; c++) {
            var cb = checkboxes[c];
            var labelEl = cb.closest('label') || cb.parentElement;
            var txt = labelEl ? (labelEl.textContent || '').trim() : '';
            if (/可见|公开|visible/i.test(txt) && cb.checked) {
                realClick(cb);
                await sleep(CONFIG.DELAY_AFTER_CLICK);
            }
        }
        return { success: true };
    }

    // ===================== 弹窗处理 =====================
    async function dismissModal() {
        await sleep(500);
        var selectors = ['.u-dialog', '.m-dialog', '.u-popup', '.u-layer', '[class*="dialog"]', '[class*="modal"]'];
        for (var s = 0; s < selectors.length; s++) {
            var modals = document.querySelectorAll(selectors[s]);
            for (var i = 0; i < modals.length; i++) {
                if (!isVisible(modals[i])) continue;
                var btns = modals[i].querySelectorAll('button, a, .u-btn, .m-btn');
                for (var j = 0; j < btns.length; j++) {
                    var t = (btns[j].textContent || '').trim();
                    if (/^(确定|继续|知道了|关闭|好的)$/.test(t)) {
                        realClick(btns[j]);
                        await sleep(800);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // ===================== 提交 / 跳转 =====================
    async function submitCurrent() {
        var submitBtn = getVisibleSubmitButton();
        if (!submitBtn) return { success: false, error: '未找到可见的提交按钮' };
        realClick(submitBtn);
        await sleep(CONFIG.DELAY_AFTER_SUBMIT);
        await dismissModal();
        return { success: true };
    }

    async function goToNext() {
        var nextBtn = document.querySelector('.j-gotonext');
        if (!nextBtn || !isVisible(nextBtn)) {
            var allBtns = document.querySelectorAll('button, a, div[role="button"]');
            for (var i = 0; i < allBtns.length; i++) {
                if (!isVisible(allBtns[i])) continue;
                if (/下一份|下一题|下一页/.test(allBtns[i].textContent || '')) { nextBtn = allBtns[i]; break; }
            }
        }
        if (nextBtn && isVisible(nextBtn)) {
            realClick(nextBtn);
            await sleep(CONFIG.DELAY_AFTER_SUBMIT);
            return true;
        }
        return false;
    }

    // ===================== 列表解析（支持表格结构） =====================
    function findClickableInRow(row) {
        // 1. 明确可点击元素
        var candidates = row.querySelectorAll('a[href], button, [role="button"], [onclick]');
        for (var i = 0; i < candidates.length; i++) {
            var t = (candidates[i].textContent || '').trim();
            if (/删除|举报|下载|查看答案/.test(t)) continue;
            if (isVisible(candidates[i])) return candidates[i];
        }
        // 2. cursor:pointer 的叶子元素
        var all = row.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
            var el = all[j];
            if (el.children.length > 0) continue;
            try {
                var cur = getComputedStyle(el).cursor;
                if (cur === 'pointer' && isVisible(el)) return el;
            } catch (e) { /* ignore */ }
        }
        // 3. 兜底：整行
        return row;
    }

    function parseTableList() {
        var containers = document.querySelectorAll(
            'table, .m-table, .u-table, [class*="table-wrap"], [class*="list-table"], [class*="u-table"]'
        );
        for (var i = 0; i < containers.length; i++) {
            var t = containers[i];
            var head = (t.textContent || '').slice(0, 2000);
            if (!LIST_CONFIG.tableHints.test(head)) continue;

            var rows = t.querySelectorAll('tr, [role="row"], .row');
            if (rows.length < 2) continue;

            var items = [];
            for (var j = 0; j < rows.length; j++) {
                var row = rows[j];
                var rowTxt = (row.textContent || '').trim();

                if (row.querySelector('th, [role="columnheader"]')) continue;
                if (/^作业列表|^你的评分|^学生名/.test(rowTxt)) continue;
                if (rowTxt.length < 2) continue;

                var cells = row.querySelectorAll('td, [role="cell"], .cell, .u-table-cell');
                if (cells.length === 0) continue;

                var score = null;
                var lastText = (cells[cells.length - 1].textContent || '').trim();
                score = parseScoreFromText(lastText);
                if (score === null) {
                    for (var k = cells.length - 1; k >= 0; k--) {
                        var s = parseScoreFromText((cells[k].textContent || '').trim());
                        if (s !== null) { score = s; break; }
                    }
                }

                var completed = score !== null || /已完成|已评/.test(rowTxt);
                var enterBtn = findClickableInRow(row);
                var nameText = (cells[0].textContent || '').trim();

                items.push({
                    el: row,
                    score: score,
                    completed: completed,
                    enterBtn: enterBtn,
                    text: nameText,
                });
            }
            if (items.length > 0) {
                console.log('[MOOC互评] 表格检测到 ' + items.length + ' 条作业');
                return { items: items };
            }
        }
        return null;
    }

    function parseGenericItem(el) {
        var score = null;
        for (var i = 0; i < LIST_CONFIG.scoreSelectors.length; i++) {
            var sEl = el.querySelector(LIST_CONFIG.scoreSelectors[i]);
            if (sEl) {
                var v = parseScoreFromText(sEl.textContent);
                if (v !== null) { score = v; break; }
            }
        }
        var text = el.textContent || '';
        var completed = LIST_CONFIG.completedText.test(text) || score !== null;
        var enterBtn = findClickableInRow(el);
        return { el: el, score: score, completed: completed, enterBtn: enterBtn, text: text };
    }

    function parseScoreList() {
        // 策略 1：表格结构
        var tableResult = parseTableList();
        if (tableResult && tableResult.items.length > 0) return tableResult;

        // 策略 2：通用列表结构
        for (var i = 0; i < LIST_CONFIG.itemSelectors.length; i++) {
            var found = document.querySelectorAll(LIST_CONFIG.itemSelectors[i]);
            if (found.length > 0) {
                var items = Array.prototype.slice.call(found).map(parseGenericItem);
                console.log('[MOOC互评] 通用选择器检测到 ' + items.length + ' 条作业');
                return { items: items };
            }
        }
        return null;
    }

    // ===================== 进入 / 返回 =====================
    async function enterItem(item) {
        if (!item || !item.enterBtn) return false;
        var beforeUrl = location.href;
        var beforeLen = document.body.innerHTML.length;
        realClick(item.enterBtn);
        await waitFor(function () {
            return location.href !== beforeUrl ||
                Math.abs(document.body.innerHTML.length - beforeLen) > 500;
        }, CONFIG.FIX_PAGE_WAIT, 150);
        await sleep(500);
        return true;
    }

    async function returnToList() {
        var allBtns = document.querySelectorAll('button, a, div[role="button"]');
        for (var i = 0; i < allBtns.length; i++) {
            var b = allBtns[i];
            if (!isVisible(b)) continue;
            var t = (b.textContent || '').trim();
            if (LIST_CONFIG.backText.test(t) && t.length < 8) {
                realClick(b);
                await sleep(CONFIG.FIX_PAGE_WAIT);
                return true;
            }
        }
        try {
            history.back();
            await sleep(CONFIG.FIX_PAGE_WAIT);
            return true;
        } catch (e) {
            return false;
        }
    }

    // ===================== 评分修复主逻辑 =====================
    async function scoreFix() {
        if (!assertReviewPage()) return;
        updateStatus('📋 正在检测评分列表...');

        var listData = parseScoreList();
        if (!listData || listData.items.length === 0) {
            updateStatus('❌ 未检测到评分列表，请先进入互评列表页面再运行');
            return;
        }
        updateStatus('检测到 ' + listData.items.length + ' 份作业');

        var completed = listData.items.filter(function (it) { return it.completed && it.score !== null; });

        // 逻辑 1：没有已完成的评分作业
        if (completed.length === 0) {
            updateStatus('✅ 没有已完成的评分作业，无需修复');
            return;
        }

        var maxScore = Math.max.apply(null, completed.map(function (it) { return it.score; }));
        var notMax = completed.filter(function (it) { return it.score < maxScore; });

        if (notMax.length === 0) {
            // 逻辑 2：所有评分一致
            updateStatus('所有评分一致（均 ' + maxScore + ' 分），随机进入一份验证...');
            var pick = completed[Math.floor(Math.random() * completed.length)];
            var ok = await enterAndRate(pick);
            if (!ok) return;
            await returnToList();
            await sleep(CONFIG.FIX_LIST_WAIT);

            var newList = parseScoreList();
            if (!newList) { updateStatus('⚠️ 无法重新读取列表'); return; }
            var newCompleted = newList.items.filter(function (it) { return it.completed && it.score !== null; });

            if (newCompleted.length === 0) { updateStatus('✅ 修复完成（列表已刷新）'); return; }

            var newMax = Math.max.apply(null, newCompleted.map(function (it) { return it.score; }));
            var newNotMax = newCompleted.filter(function (it) { return it.score < newMax; });

            if (newNotMax.length === 0) {
                updateStatus('✅ 修复完成（所有评分均一致）');
            } else {
                updateStatus('⚠️ 验证后发现 ' + newNotMax.length + ' 份不一致，继续修复...');
                await fixNotMaxLoop();
            }
        } else {
            // 逻辑 3：存在不一致
            updateStatus('⚠️ 检测到 ' + notMax.length + ' 份低于最高分（' + maxScore + '），开始修复...');
            var pick2 = notMax[Math.floor(Math.random() * notMax.length)];
            updateStatus('随机进入一份进行评分，作为满分标准...');
            var ok2 = await enterAndRate(pick2);
            if (!ok2) return;
            await returnToList();
            await sleep(CONFIG.FIX_LIST_WAIT);
            await fixNotMaxLoop();
        }
    }

    async function enterAndRate(item) {
        if (!item || !item.enterBtn) {
            updateStatus('❌ 该条目没有可用的进入按钮');
            return false;
        }
        if (!await enterItem(item)) {
            updateStatus('❌ 无法进入作业');
            return false;
        }
        await sleep(1000);

        var r = await rateCurrentAssignment();
        if (!r.success) {
            updateStatus('❌ 评分失败：' + r.error);
            await returnToList();
            return false;
        }
        var s = await submitCurrent();
        if (!s.success) {
            updateStatus('❌ 提交失败：' + s.error);
            await returnToList();
            return false;
        }
        return true;
    }

    async function fixNotMaxLoop() {
        var loop = 0;
        while (loop < CONFIG.FIX_MAX_LOOPS) {
            loop++;
            if (taskState.cancelled) throw makeCancelError();

            var listData = parseScoreList();
            if (!listData || listData.items.length === 0) {
                updateStatus('⚠️ 无法读取列表，停止修复');
                return;
            }
            var completed = listData.items.filter(function (it) { return it.completed && it.score !== null; });
            if (completed.length === 0) { updateStatus('✅ 修复完成（无已完成作业）'); return; }

            var maxScore = Math.max.apply(null, completed.map(function (it) { return it.score; }));
            var notMax = completed.filter(function (it) { return it.score < maxScore; });

            if (notMax.length === 0) {
                updateStatus('✅ 修复完成（共 ' + loop + ' 次修复，所有评分一致）');
                return;
            }

            updateStatus('修复中... 剩余 ' + notMax.length + ' 份 (第 ' + loop + ' 次)');
            var item = notMax[0];

            var ok = await enterAndRate(item);
            if (!ok) { updateStatus('⚠️ 修复中途失败，已停止'); return; }
            await returnToList();
            await sleep(CONFIG.FIX_LIST_WAIT);
        }
        updateStatus('⚠️ 达到安全上限 ' + CONFIG.FIX_MAX_LOOPS + ' 次，停止修复');
    }

    // ===================== 三种互评模式 =====================
    async function oneClickReview() {
        if (!assertReviewPage()) return;
        updateStatus('正在评分当前作业...');
        var r = await rateCurrentAssignment();
        if (!r.success) { updateStatus('评分失败：' + r.error); return; }
        updateStatus('正在提交...');
        var s = await submitCurrent();
        if (!s.success) { updateStatus('提交失败：' + s.error); return; }
        updateStatus('当前作业互评完成 ✓');
    }

    async function batchReview(count) {
        if (!assertReviewPage()) return;
        var success = 0;
        while (success < count) {
            if (isFinished()) { updateStatus('已完成 ' + success + ' 份，无更多作业可评'); return; }
            updateStatus('正在互评第 ' + (success + 1) + '/' + count + ' 份...');
            var r = await rateCurrentAssignment();
            if (!r.success) { updateStatus('第 ' + (success + 1) + ' 份评分失败：' + r.error); return; }
            var s = await submitCurrent();
            if (!s.success) { updateStatus('第 ' + (success + 1) + ' 份提交失败：' + s.error); return; }
            success++;
            if (success >= count) break;
            var moved = await goToNext();
            if (!moved) {
                await sleep(1500);
                if (!getVisibleSubmitButton()) { updateStatus('已完成 ' + success + ' 份（无更多作业）'); return; }
            }
        }
        updateStatus('快速互评完成，共 ' + success + ' 份 ✓');
    }

    async function autoReviewAll() {
        if (!assertReviewPage()) return;
        var count = 0;
        while (count < CONFIG.MAX_ITERATIONS) {
            if (isFinished()) { updateStatus('全部互评已完成，共 ' + count + ' 份 ✓'); return; }
            updateStatus('全自动互评中... 已完成 ' + count + ' 份');
            var r = await rateCurrentAssignment();
            if (!r.success) { updateStatus('第 ' + (count + 1) + ' 份评分失败：' + r.error); return; }
            var s = await submitCurrent();
            if (!s.success) { updateStatus('第 ' + (count + 1) + ' 份提交失败：' + s.error); return; }
            count++;
            var moved = await goToNext();
            if (!moved) {
                await sleep(1500);
                if (!getVisibleSubmitButton()) { updateStatus('全部互评已完成，共 ' + count + ' 份 ✓'); return; }
            }
        }
        updateStatus('已达安全上限 ' + CONFIG.MAX_ITERATIONS + ' 份，停止');
    }

    // ===================== 答题探针（诊断用，不修改页面状态） =====================
    // 用途：在真实答题页上把 DOM 结构、题型标记、提交按钮、剩余次数、页面 JS 全局变量
    // 和 XHR/fetch 请求形状 dump 出来，作为编写选择题选择器和决定数据来源的依据。
    // 探针只读 DOM、只包裹网络方法，不点击任何按钮、不修改任何输入。

    var netLog = [];
    var netProbeInstalled = false;

    function describeShape(obj, depth, maxDepth) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (depth >= maxDepth) return typeof obj;
        if (Object.prototype.toString.call(obj) === '[object Array]') {
            if (obj.length === 0) return '[]';
            return '[' + obj.length + ' x ' + describeShape(obj[0], depth + 1, maxDepth) + ']';
        }
        if (typeof obj === 'object') {
            var parts = [], n = 0;
            for (var k in obj) {
                if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                if (n++ >= 25) { parts.push('...'); break; }
                // 答案类字段直接把值带出来——探针的核心目的就是确认答案是否已在响应里
                if (/answer|correct|right|key|result|score/i.test(k)) {
                    var sv;
                    try { sv = JSON.stringify(obj[k]); } catch (e) { sv = '(无法序列化)'; }
                    parts.push(k + ': ' + String(sv).slice(0, 120));
                } else {
                    parts.push(k + ': ' + describeShape(obj[k], depth + 1, maxDepth));
                }
            }
            return '{' + parts.join(', ') + '}';
        }
        return typeof obj;
    }

    function installNetworkProbe() {
        if (netProbeInstalled) return;
        netProbeInstalled = true;

        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__marMethod = method;
            this.__marUrl = url;
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
            var xhr = this;
            var url = String(xhr.__marUrl || '');
            if (/quiz|exam|paper|answer|dwr|homework|test/i.test(url)) {
                xhr.addEventListener('load', function () {
                    var shape;
                    try { shape = describeShape(JSON.parse(xhr.responseText), 0, 3); }
                    catch (e) { shape = '(非 JSON，长度 ' + (xhr.responseText || '').length + ')'; }
                    var entry = { via: 'xhr', method: xhr.__marMethod, url: url, status: xhr.status, shape: shape };
                    netLog.push(entry);
                    console.log('[MOOC答题探针] 网络请求', entry);
                });
            }
            return origSend.apply(this, arguments);
        };

        if (typeof window.fetch === 'function') {
            var origFetch = window.fetch;
            window.fetch = function (input, init) {
                var url = String((typeof input === 'string') ? input : (input && input.url) || '');
                var p = origFetch.apply(this, arguments);
                if (/quiz|exam|paper|answer|dwr|homework|test/i.test(url)) {
                    p.then(function (resp) {
                        return resp.clone().text().then(function (text) {
                            var shape;
                            try { shape = describeShape(JSON.parse(text), 0, 3); }
                            catch (e) { shape = '(非 JSON，长度 ' + text.length + ')'; }
                            var entry = {
                                via: 'fetch',
                                method: (init && init.method) || 'GET',
                                url: url, status: resp.status, shape: shape
                            };
                            netLog.push(entry);
                            console.log('[MOOC答题探针] 网络请求', entry);
                        });
                    }).catch(function () { /* 探针自身不得影响页面请求 */ });
                }
                return p;
            };
        }
        console.log('[MOOC答题探针] 网络探针已安装，后续 /quiz|exam|paper|answer/ 相关请求会被记录');
    }

    var PROBE_SELECTORS = [
        '.j-question', '.u-question', '.m-question', '.question', '.q-item',
        '.j-que', '.u-que', '.que-item', '.item-question', '.u-questionItem',
        '[data-question]', '[class*="question"]', '[class*="subject"]',
        '[class*="ques"]', '.m-list .item', '.j-list .item', '.list .item',
    ];

    function probeSelectors() {
        var out = [];
        for (var i = 0; i < PROBE_SELECTORS.length; i++) {
            var n = 0;
            try { n = document.querySelectorAll(PROBE_SELECTORS[i]).length; } catch (e) { n = -1; }
            if (n > 0) out.push({ selector: PROBE_SELECTORS[i], count: n });
        }
        return out;
    }

    // 从选项 input 往上爬祖先链——这直接给出“题块容器该用哪一层”的答案
    function ancestorLadder(el, maxDepth) {
        var out = [], cur = el, d = 0;
        while (cur && cur !== document.body && d < maxDepth) {
            var txt = (cur.textContent || '').replace(/\s+/g, ' ').trim();
            var cls = (typeof cur.className === 'string') ? cur.className : '';
            out.push({
                depth: d,
                tag: cur.tagName,
                id: cur.id || '',
                cls: cls.slice(0, 120),
                inputs: cur.querySelectorAll('input, textarea, select').length,
                textLen: txt.length,
                textHead: txt.slice(0, 120)
            });
            cur = cur.parentElement;
            d++;
        }
        return out;
    }

    function probeInputs(scope) {
        var out = [];
        var els = scope.querySelectorAll('input, textarea, select');
        for (var i = 0; i < els.length && i < 30; i++) {
            var e = els[i];
            out.push({
                tag: e.tagName,
                type: e.type || '',
                name: e.name || '',
                id: e.id || '',
                value: (e.value || '').slice(0, 40),
                checked: !!e.checked,
                cls: ((typeof e.className === 'string') ? e.className : '').slice(0, 80),
                editable: e.getAttribute ? (e.getAttribute('contenteditable') || '') : ''
            });
        }
        return out;
    }

    function probeOptionLabels(scope) {
        var out = [];
        var els = scope.querySelectorAll('label, li, .option, [class*="option"], [class*="item"]');
        for (var i = 0; i < els.length && i < 30; i++) {
            var e = els[i];
            if (e.children.length > 3) continue; // 跳过明显是容器的节点
            var t = (e.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t) continue;
            out.push({
                tag: e.tagName,
                cls: ((typeof e.className === 'string') ? e.className : '').slice(0, 80),
                text: t.slice(0, 80)
            });
        }
        return out;
    }

    // 选项正文诊断。观察到的现象是 `.optionCnt` 的 textContent 为空、里面只有一个图标 span，
    // 还挂着 edueditor_styleclass_NN 这类注入式类名。正文到底渲染在哪里（CSS content /
    // 图片 / 异步加载 / 根本没渲染）决定了“按选项文本映射答案”这条路是否成立。
    function probeOptionContentDiag() {
        var out = [];
        var opts = document.querySelectorAll('.optionCnt, .choices > li, .u-questionItem li');
        for (var i = 0; i < opts.length && out.length < 8; i++) {
            var el = opts[i];
            var d = {
                tag: el.tagName,
                cls: ((typeof el.className === 'string') ? el.className : '').slice(0, 140),
                textContent: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                innerHTML: (el.innerHTML || '').replace(/\s+/g, ' ').slice(0, 400),
                childTags: [],
                imgSrcs: []
            };
            for (var c = 0; c < el.children.length && c < 8; c++) {
                var k = el.children[c];
                var kcls = (typeof k.className === 'string') ? k.className : '';
                d.childTags.push(k.tagName + '.' + kcls.slice(0, 60));
            }
            var imgs = el.querySelectorAll('img');
            for (var m = 0; m < imgs.length && m < 5; m++) d.imgSrcs.push(String(imgs[m].src || '').slice(0, 200));
            try {
                var cs = getComputedStyle(el);
                d.backgroundImage = String(cs.backgroundImage || '').slice(0, 200);
                d.beforeContent = String(getComputedStyle(el, '::before').content || '');
                d.afterContent = String(getComputedStyle(el, '::after').content || '');
            } catch (e) { /* ignore */ }
            out.push(d);
        }
        return out;
    }

    // 在样式表里找注入式类名（如 edueditor_styleclass_13）对应的规则，
    // 确认选项正文是不是被写进 CSS 的 content 属性里
    function probeStyleRules(nameFragment) {
        var out = [], sheets = document.styleSheets;
        for (var i = 0; i < sheets.length && out.length < 15; i++) {
            var rules;
            try { rules = sheets[i].cssRules; } catch (e) { continue; } // 跨域样式表读 cssRules 会抛
            if (!rules) continue;
            for (var j = 0; j < rules.length && out.length < 15; j++) {
                var r = rules[j];
                if ((r.selectorText || '').indexOf(nameFragment) === -1) continue;
                out.push({ selector: r.selectorText.slice(0, 160), css: String(r.cssText || '').slice(0, 400) });
            }
        }
        return out;
    }

    // 把容器文本里“选项区/分析区”整块剪掉，剩下的就是题干。
    // 这同时是正式解析器要用的算法，放在探针里先验证。
    function extractStemGuess(item) {
        var clone = item.cloneNode(true);
        var cut = clone.querySelectorAll('ul.choices, .j-choicebox, .analysis, .u-answerbox, .u-icon-correct, .u-icon-wrong, script, style');
        for (var i = 0; i < cut.length; i++) {
            if (cut[i].parentNode) cut[i].parentNode.removeChild(cut[i]);
        }
        var s = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        // 站点把「得分/总分」当作独立文本节点直接放在题块里，它不是题干的一部分。
        // 不去掉的话题干会变成「…关系？得分/总分」，只能靠模糊匹配侥幸兜住。
        s = s.replace(/得分\s*\/\s*总分/g, ' ').replace(/\s+/g, ' ').trim();
        // 开头的题号也去掉——演练报告里本来就会编号
        s = s.replace(/^\d{1,3}\s+/, '');
        return s.slice(0, 300);
    }

    // 逐选项全量 dump。目的：搞清为什么 4 选项题的 .optionCnt 有文字，
    // 而 2 选项判断题的 .optionCnt 只有图标、没有文字。
    function probeAllOptions() {
        var out = [];
        var items = document.querySelectorAll('.u-questionItem');
        for (var q = 0; q < items.length && q < 6; q++) {
            var item = items[q];
            var cls = String(item.className || '');
            var rec = {
                qIndex: q,
                cls: cls.slice(0, 150),
                mode: /examMode/.test(cls) ? 'examMode'
                    : /analysisMode/.test(cls) ? 'analysisMode' : 'normal',
                stemGuess: extractStemGuess(item),
                containerText: (item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
                options: []
            };
            var lis = item.querySelectorAll('ul.choices > li');
            for (var L = 0; L < lis.length && L < 10; L++) {
                var li = lis[L];
                var cnt = li.querySelector('.optionCnt');
                var pos = li.querySelector('.optionPos');
                var inp = li.querySelector('input');
                var o = {
                    idx: L,
                    pos: pos ? (pos.textContent || '').trim() : '',
                    checked: inp ? !!inp.checked : null,
                    inputType: inp ? inp.type : '',
                    disabled: inp ? !!inp.disabled : null,
                    correctIcon: !!li.querySelector('.u-icon-correct'),
                    wrongIcon: !!li.querySelector('.u-icon-wrong'),
                    cntText: cnt ? (cnt.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 110) : null,
                    cntHtml: cnt ? cnt.innerHTML.replace(/\s+/g, ' ').slice(0, 260) : null,
                    imgCount: cnt ? cnt.querySelectorAll('img').length : 0
                };
                if (cnt) {
                    try {
                        o.cntBefore = String(getComputedStyle(cnt, '::before').content || '');
                        o.cntAfter = String(getComputedStyle(cnt, '::after').content || '');
                    } catch (e) { o.cntBefore = o.cntAfter = '?'; }
                }
                rec.options.push(o);
            }
            out.push(rec);
        }
        return out;
    }

    function probeQuestions(limit) {
        var out = [];
        var inputs = document.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea');
        var seen = [];
        for (var i = 0; i < inputs.length && out.length < limit; i++) {
            var el = inputs[i];
            var ladder = ancestorLadder(el, 8);
            // 同一道题的多个选项会爬到同一条祖先链，用「第 3 层祖先」去重
            var marker = ladder.length > 3 ? (ladder[3].tag + '|' + ladder[3].cls + '|' + ladder[3].textHead) : String(i);
            if (seen.indexOf(marker) !== -1) continue;
            seen.push(marker);
            var container = el;
            for (var up = 0; up < 3 && container && container.parentElement; up++) container = container.parentElement;
            out.push({
                index: out.length,
                triggerInput: {
                    type: el.type || el.tagName,
                    name: el.name || '',
                    id: el.id || ''
                },
                ladder: ladder,
                containerHtml: container ? container.innerHTML.replace(/\s+/g, ' ').slice(0, 600) : '',
                containerInputs: container ? probeInputs(container) : [],
                containerLabels: container ? probeOptionLabels(container) : []
            });
        }
        return out;
    }

    function probeButtons() {
        var out = [];
        var els = document.querySelectorAll('button, a, div[role="button"], input[type="submit"]');
        for (var i = 0; i < els.length && out.length < 40; i++) {
            var e = els[i];
            if (!isVisible(e)) continue;
            var t = (e.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 24) continue;
            if (!/提交|交卷|保存|下一|上一|翻页|确定|取消|返回|重做|继续|查看答案|答案解析/.test(t)) continue;
            out.push({
                tag: e.tagName,
                cls: ((typeof e.className === 'string') ? e.className : '').slice(0, 80),
                id: e.id || '',
                text: t,
                disabled: !!e.disabled
            });
        }
        return out;
    }

    function probeAttempts() {
        var txt = (document.body ? (document.body.textContent || '') : '').replace(/\s+/g, ' ');
        var out = [];
        // 只在关键词邻域内截取，并限长，否则会捞回一大段题目正文
        var re = /(剩余|可尝试|作答次数|考试次数|剩余次数|已提交|已作答|重做|重新作答|机会)[^。；\n]{0,24}/g;
        var m;
        while ((m = re.exec(txt)) !== null && out.length < 20) {
            var s = m[0].trim();
            if (s.length > 40) continue;
            if (out.indexOf(s) === -1) out.push(s);
        }
        return out;
    }

    // 站点自带的「智能助教」浮层里也有“题目解析”字样，会淹没真正的答案区，要排除掉
    function isAssistantNode(el) {
        return !!(el.closest && el.closest(
            '#globalAIAssistantBtn, [data-code="assistantChat"], [id="userQuery"], [id="assistantAnswer"]'
        ));
    }

    function probeRevealRegion() {
        var hints = ['正确答案', '参考答案', '你的答案', '答案解析'];
        var out = [];
        var all = document.querySelectorAll('div, section, li, p, span');
        for (var i = 0; i < all.length && out.length < 8; i++) {
            var e = all[i];
            if (isAssistantNode(e)) continue;
            var t = (e.textContent || '').replace(/\s+/g, ' ').trim();
            for (var h = 0; h < hints.length; h++) {
                if (t.indexOf(hints[h]) !== -1 && t.length < 300) {
                    out.push({
                        hint: hints[h],
                        tag: e.tagName,
                        cls: ((typeof e.className === 'string') ? e.className : '').slice(0, 80),
                        text: t.slice(0, 200),
                        html: e.innerHTML.replace(/\s+/g, ' ').slice(0, 400)
                    });
                    break;
                }
            }
        }
        return out;
    }

    function probeWindowGlobals() {
        var hits = [], keys;
        try { keys = Object.keys(window); } catch (e) { return hits; }
        var re = /answer|quiz|exam|question|paper|init|__|course/i;
        for (var i = 0; i < keys.length && hits.length < 50; i++) {
            var k = keys[i];
            if (!re.test(k)) continue;
            var t, sample;
            try {
                var v = window[k];
                t = (v === null) ? 'null' : (typeof v);
                if (typeof v === 'string') sample = v.slice(0, 100);
                else if (v && t === 'object') sample = describeShape(v, 0, 2);
                else sample = '';
            } catch (e) { t = '(读取失败)'; sample = ''; }
            hits.push({ key: k, type: t, sample: String(sample).slice(0, 200) });
        }
        return hits;
    }

    function getCspMeta() {
        var m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        return m ? (m.getAttribute('content') || '') : '(页面无 CSP meta)';
    }

    function collectQuizProbe() {
        return {
            probedAt: new Date().toISOString(),
            href: location.href,
            hash: location.hash,
            pageType: detectPageType(),
            cspMeta: getCspMeta(),
            selectorHits: probeSelectors(),
            questions: probeQuestions(3),
            optionContentDiag: probeOptionContentDiag(),
            styleClassRules: probeStyleRules('edueditor_styleclass'),
            allOptions: probeAllOptions(),
            buttons: probeButtons(),
            attemptTexts: probeAttempts(),
            revealRegions: probeRevealRegion(),
            windowGlobals: probeWindowGlobals(),
            network: netLog.slice(),
            networkProbeInstalled: netProbeInstalled,
            note: netProbeInstalled
                ? '网络探针已安装。请在本页翻页 / 点一个选项 / 交卷，然后再点一次「答题探针」取回网络记录。'
                : '网络探针尚未安装，点一次「答题探针」即可安装。'
        };
    }

    // 通用文本浮层：探针报告、自检明细、题库导入共用。
    // 传了 onSave 就多一个「保存」按钮，文本框可编辑；否则是只读查看。
    function showTextOverlay(title, text, onSave) {
        var old = document.getElementById('mar-probe-overlay');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var overlay = document.createElement('div');
        overlay.id = 'mar-probe-overlay';
        overlay.innerHTML = [
            '<div id="mar-probe-head">',
            '  <span id="mar-probe-title"></span>',
            '  <span id="mar-probe-actions">',
            onSave ? '    <button id="mar-probe-save" class="mar-btn">保存</button>' : '',
            '    <button id="mar-probe-copy" class="mar-btn">复制</button>',
            '    <button id="mar-probe-close" class="mar-btn">关闭</button>',
            '  </span>',
            '</div>',
            '<textarea id="mar-probe-text" spellcheck="false"></textarea>'
        ].join('');
        document.body.appendChild(overlay);

        // 标题用 textContent 赋值，避免把内容里的尖括号当 HTML 解析
        document.getElementById('mar-probe-title').textContent = title;

        var ta = document.getElementById('mar-probe-text');
        ta.value = text;
        ta.focus();
        ta.select();

        document.getElementById('mar-probe-close').addEventListener('click', function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        });
        document.getElementById('mar-probe-copy').addEventListener('click', function () {
            ta.focus();
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            updateStatus(ok ? '✅ 已复制到剪贴板' : '⚠️ 自动复制失败，请手动全选复制文本框内容');
        });
        if (onSave) {
            document.getElementById('mar-probe-save').addEventListener('click', function () {
                onSave(ta.value);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            });
        }
    }

    function showProbeResult(report) {
        var text = JSON.stringify(report, null, 2);
        console.log('[MOOC答题探针] 报告对象', report);
        console.log('[MOOC答题探针] 报告文本\n' + text);
        showTextOverlay('答题探针结果 · 全选复制后回传', text);
    }

    async function quizProbe() {
        installNetworkProbe();
        updateStatus('🔬 正在采集答题页结构...');
        await sleep(200);
        var report = collectQuizProbe();
        showProbeResult(report);
        var qn = report.questions.length;
        updateStatus('🔬 探针完成：识别到 ' + qn + ' 个候选题块、' + report.selectorHits.length + ' 个命中选择器'
            + (netProbeInstalled ? '。网络探针已装，翻页/点选项后请再点一次探针' : ''));
    }

    // ===================== 状态栏 & 按钮 =====================
    var statusEl = null;
    function updateStatus(msg) {
        if (statusEl) statusEl.textContent = msg;
        console.log('[MOOC互评]', msg);
    }

    // 按选择器收集而不是硬编码 id 列表。原来那份硬编码清单是个持续的坑：
    // 每加一个按钮都得记得往数组里补一条，漏了就变成「运行期间还能点」。
    function setButtonsRunning(isRunning) {
        var btns = document.querySelectorAll('#mooc-auto-review-panel .mar-btn');
        for (var i = 0; i < btns.length; i++) {
            var el = btns[i];
            if (el.id === 'mar-stop') continue;
            // 开关类按钮（自动提交 / 解除复制）与任务状态无关，
            // 任务跑着的时候也应该能随时切换
            if (el.classList.contains('mar-toggle')) continue;
            el.disabled = isRunning;
        }
        var stop = document.getElementById('mar-stop');
        if (stop) {
            stop.style.display = isRunning ? 'flex' : 'none';
            stop.disabled = !isRunning;
        }
    }
    function injectStyles() {
        if (document.getElementById('mar-glass-styles')) return;
        var style = document.createElement('style');
        style.id = 'mar-glass-styles';
        style.textContent = [
            '#mooc-auto-review-panel {',
            '  position: fixed !important;',
            '  top: 100px; right: 20px;',
            '  z-index: 2147483647 !important;',
            '  width: 252px;',
            '  border-radius: 18px;',
            '  overflow: hidden;',
            '  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;',
            '  color: #1c1c1e;',
            '  user-select: none;',
            '  background: rgba(252, 252, 254, 0.68);',
            '  backdrop-filter: blur(32px) saturate(180%);',
            '  -webkit-backdrop-filter: blur(32px) saturate(180%);',
            '  border: 1px solid rgba(255, 255, 255, 0.75);',
            '  box-shadow:',
            '    0 12px 32px -8px rgba(15, 20, 40, 0.18),',
            '    0 2px 8px -2px rgba(15, 20, 40, 0.08),',
            '    inset 0 1px 0 rgba(255, 255, 255, 0.95),',
            '    inset 0 -1px 0 rgba(255, 255, 255, 0.35);',
            '}',
            '#mar-header {',
            '  display: flex; justify-content: space-between; align-items: center;',
            '  padding: 11px 14px; cursor: move;',
            '  font-size: 13px; font-weight: 600; letter-spacing: 0.01em;',
            '  color: #1c1c1e;',
            '  background: rgba(255, 255, 255, 0.22);',
            '  border-bottom: 1px solid rgba(255, 255, 255, 0.55);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);',
            '}',
            '#mar-title { display: flex; align-items: center; gap: 7px; }',
            '#mar-title .mar-dot {',
            '  width: 7px; height: 7px; border-radius: 50%;',
            '  background: #4a90e2;',
            '  box-shadow: 0 0 0 2px rgba(74, 144, 226, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.6);',
            '}',
            '#mar-minimize {',
            '  cursor: pointer; width: 22px; height: 22px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  border-radius: 50%;',
            '  background: rgba(255, 255, 255, 0.55);',
            '  border: 1px solid rgba(255, 255, 255, 0.8);',
            '  font-size: 13px; line-height: 1; color: #3a3a3c;',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(0, 0, 0, 0.05);',
            '  transition: background 0.18s ease, transform 0.18s ease;',
            '}',
            '#mar-minimize:hover { background: rgba(255, 255, 255, 0.85); transform: scale(1.06); }',
            '#mar-minimize:active { transform: scale(0.94); }',
            // 选项卡：分段控件样式，选中项是一枚浮起的白色药丸
            '#mar-tabs {',
            '  display: flex; gap: 3px;',
            '  padding: 7px 9px 0;',
            '}',
            '.mar-tab {',
            '  position: relative; flex: 1;',
            '  padding: 6px 4px; border: 1px solid transparent;',
            '  border-radius: 9px;',
            '  background: transparent;',
            '  font-family: inherit; font-size: 12px; font-weight: 500;',
            '  color: #7a7a80; cursor: pointer;',
            '  transition: color 0.16s ease, background 0.16s ease;',
            '}',
            '.mar-tab:hover:not(.mar-active) { color: #1c1c1e; background: rgba(255, 255, 255, 0.34); }',
            '.mar-tab.mar-active {',
            '  color: #1c1c1e; font-weight: 600;',
            '  background: rgba(255, 255, 255, 0.62);',
            '  border-color: rgba(255, 255, 255, 0.75);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(15, 20, 40, 0.05);',
            '}',
            // 自动提交开着时，在「答题」选项卡上挂个橙点。
            // 这是整个脚本里最危险的一个状态，切到别的选项卡也必须在视野里留着。
            '.mar-tab.mar-alert::before {',
            '  content: ""; position: absolute; top: 5px; right: 8px;',
            '  width: 5px; height: 5px; border-radius: 50%;',
            '  background: #f97316;',
            '  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.95);',
            '}',
            // 视图：同一时刻只有一个 .mar-pane 是 flex
            '.mar-pane { display: none; flex-direction: column; gap: 7px; }',
            '.mar-pane.mar-active { display: flex; }',
            '#mar-body { padding: 10px 12px; }',
            // 状态栏和停止按钮独立于选项卡：切到哪个视图都能看到进度、都能停
            '#mar-foot { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 7px; }',
            '.mar-btn {',
            '  position: relative; display: flex; align-items: center; gap: 9px;',
            '  padding: 9px 12px; border-radius: 11px;',
            '  border: 1px solid rgba(255, 255, 255, 0.75);',
            '  background: rgba(255, 255, 255, 0.42);',
            '  color: #1c1c1e; font-family: inherit;',
            '  font-size: 12.5px; font-weight: 500; text-align: left;',
            '  cursor: pointer;',
            '  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 1px 2px rgba(15, 20, 40, 0.05);',
            '  transition: background 0.18s ease, transform 0.14s ease, box-shadow 0.18s ease;',
            '}',
            '.mar-btn::before {',
            '  content: ""; width: 6px; height: 6px; border-radius: 50%;',
            '  flex-shrink: 0; background: #94a3b8;',
            '  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);',
            '  transition: transform 0.18s ease;',
            '}',
            '#mar-one::before   { background: #4a90e2; }',
            '#mar-batch::before { background: #34a853; }',
            '#mar-auto::before  { background: #f5a623; }',
            '#mar-fix::before   { background: #8b5cf6; }',
            '#mar-stop::before  { background: #e53e3e; }',
            '.mar-btn:hover:not(:disabled) {',
            '  background: rgba(255, 255, 255, 0.72); transform: translateY(-1px);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 10px -2px rgba(15, 20, 40, 0.12);',
            '}',
            '.mar-btn:hover:not(:disabled)::before { transform: scale(1.15); }',
            '.mar-btn:active:not(:disabled) {',
            '  transform: translateY(0); background: rgba(255, 255, 255, 0.5);',
            '  box-shadow: inset 0 1px 3px rgba(15, 20, 40, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6);',
            '}',
            '.mar-btn:disabled { opacity: 0.42; cursor: not-allowed; filter: saturate(0.4); }',
            '#mar-fix:not(:disabled) { color: #6d28d9; background: rgba(243, 236, 255, 0.55); border-color: rgba(200, 180, 255, 0.8); }',
            '#mar-fix:hover:not(:disabled) {',
            '  background: rgba(238, 226, 255, 0.85);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 12px -2px rgba(109, 40, 217, 0.22);',
            '}',
            '#mar-stop:not(:disabled) { color: #b42318; background: rgba(255, 236, 236, 0.6); border-color: rgba(255, 200, 200, 0.8); }',
            '#mar-stop:hover:not(:disabled) {',
            '  background: rgba(255, 224, 224, 0.85);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 1), 0 4px 12px -2px rgba(180, 35, 24, 0.22);',
            '}',
            // 停止按钮平时不占地方，只有任务在跑时才由 setButtonsRunning() 放出来
            '#mar-stop { display: none; }',
            '#mar-status {',
            '  padding: 9px 11px; border-radius: 10px;',
            '  background: rgba(255, 255, 255, 0.3);',
            '  border: 1px solid rgba(255, 255, 255, 0.55);',
            '  box-shadow: inset 0 1px 2px rgba(15, 20, 40, 0.04), inset 0 -1px 0 rgba(255, 255, 255, 0.6);',
            '  font-size: 11.5px; line-height: 1.5; color: #3a3a3c;',
            '  min-height: 16px; word-break: break-all;',
            '  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);',
            '}',
            '#mar-quiz-probe::before { background: #14b8a6; }',
            '#mar-quiz-selftest::before { background: #0ea5e9; }',
            '#mar-quiz-import::before { background: #a855f7; }',
            '#mar-quiz-dryrun::before { background: #06b6d4; }',
            '#mar-quiz-answer::before { background: #22c55e; }',
            '#mar-quiz-autosubmit::before { background: #64748b; }',
            '#mar-quiz-autosubmit.mar-on::before { background: #f97316; }',
            '#mar-quiz-autosubmit.mar-on:not(:disabled) {',
            '  color: #9a3412; background: rgba(255, 241, 230, 0.65);',
            '  border-color: rgba(255, 200, 160, 0.85);',
            '}',
            // 未解决的题目在页面上描个红框，让人一眼看到该补哪几道
            '.mar-uncertain {',
            '  outline: 2px dashed #ef4444 !important;',
            '  outline-offset: 3px;',
            '  border-radius: 4px;',
            '}',
            '#mar-copy-unlock::before { background: #64748b; }',
            // 开启态：绿点 + 淡绿底，一眼能看出复制限制现在是解开的
            '#mar-copy-unlock.mar-on::before { background: #22c55e; }',
            '#mar-copy-unlock.mar-on:not(:disabled) {',
            '  color: #15803d; background: rgba(226, 252, 235, 0.6);',
            '  border-color: rgba(160, 230, 190, 0.85);',
            '}',
            '#mar-copy-unlock.mar-on:hover:not(:disabled) { background: rgba(214, 250, 226, 0.88); }',
            // 探针结果浮层：只读诊断用，全选复制
            '#mar-probe-overlay {',
            '  position: fixed !important;',
            '  top: 5vh; left: 50%; transform: translateX(-50%);',
            '  width: min(900px, 92vw); height: 90vh;',
            '  z-index: 2147483647 !important;',
            '  display: flex; flex-direction: column;',
            '  border-radius: 14px; overflow: hidden;',
            '  background: rgba(28, 28, 32, 0.97);',
            '  border: 1px solid rgba(255, 255, 255, 0.16);',
            '  box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.6);',
            '  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;',
            '  user-select: text;',
            '}',
            '#mar-probe-head {',
            '  display: flex; justify-content: space-between; align-items: center;',
            '  gap: 12px; padding: 10px 14px;',
            '  background: rgba(255, 255, 255, 0.06);',
            '  border-bottom: 1px solid rgba(255, 255, 255, 0.12);',
            '  color: #f2f2f7; font-size: 13px; font-weight: 600;',
            '}',
            '#mar-probe-actions { display: flex; gap: 8px; }',
            '#mar-probe-actions .mar-btn {',
            '  padding: 5px 12px; font-size: 12px; width: auto;',
            '  color: #f2f2f7; background: rgba(255, 255, 255, 0.12);',
            '  border: 1px solid rgba(255, 255, 255, 0.2);',
            '}',
            '#mar-probe-actions .mar-btn::before { display: none; }',
            '#mar-probe-actions .mar-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.22); }',
            '#mar-probe-text {',
            '  flex: 1; width: 100%; resize: none; border: 0; outline: none;',
            '  padding: 12px 14px; margin: 0;',
            '  background: transparent; color: #d7d7dc;',
            '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
            '  font-size: 12px; line-height: 1.5;',
            '  white-space: pre; overflow: auto;',
            '  user-select: text;',
            '}',
        ].join('\n');
        document.head.appendChild(style);
    }

    // ===================== 悬浮窗 UI =====================
    // 选项卡名 → 视图。切选项卡只是换 .mar-pane 的显示，不动任何任务状态，
    // 所以任务跑着的时候切走再切回来不会打断它。
    function switchTab(name) {
        // 名字不存在就直接不动。真要是切到一个拼错的视图名，所有 pane 都不带
        // .mar-active，面板会变成一片空白且看不出原因——不如保持原样。
        if (!document.querySelector('#mooc-auto-review-panel .mar-pane[data-pane="' + name + '"]')) return;
        var tabs = document.querySelectorAll('#mooc-auto-review-panel .mar-tab');
        for (var i = 0; i < tabs.length; i++) {
            var on = tabs[i].getAttribute('data-tab') === name;
            if (on) tabs[i].classList.add('mar-active');
            else tabs[i].classList.remove('mar-active');
        }
        var panes = document.querySelectorAll('#mooc-auto-review-panel .mar-pane');
        for (var j = 0; j < panes.length; j++) {
            var p = panes[j];
            if (p.getAttribute('data-pane') === name) p.classList.add('mar-active');
            else p.classList.remove('mar-active');
        }
    }

    // 自动提交开着时在「答题」选项卡上留个橙点：这个状态切到别的选项卡也看得见
    function updateTabAlert() {
        var tab = document.querySelector('#mooc-auto-review-panel .mar-tab[data-tab="quiz"]');
        if (!tab) return;
        if (isAutoSubmitOn()) tab.classList.add('mar-alert');
        else tab.classList.remove('mar-alert');
    }

    // 默认打开哪个选项卡，按页面类型定：答题页给「答题」，其余给「互评」。
    // 只在面板创建时判定一次——之后用户手动切到哪就是哪，不跟着 hash 导航乱跳。
    function pickDefaultTab() {
        var t = detectPageType();
        if (t === 'quiz' || t === 'exam' || t === 'question') return 'quiz';
        return 'review';
    }

    function createFloatingPanel() {
        if (document.getElementById('mooc-auto-review-panel')) return;
        injectStyles();

        var panel = document.createElement('div');
        panel.id = 'mooc-auto-review-panel';
        panel.innerHTML = [
            '<div id="mar-header">',
            '  <span id="mar-title"><span class="mar-dot"></span>MOOC 助手</span>',
            '  <span id="mar-minimize" title="最小化">−</span>',
            '</div>',
            '<div id="mar-main">',
            '  <div id="mar-tabs">',
            '    <button class="mar-tab" data-tab="review">互评</button>',
            '    <button class="mar-tab" data-tab="quiz">答题</button>',
            '    <button class="mar-tab" data-tab="general">通用</button>',
            '  </div>',
            '  <div id="mar-body">',
            '    <div class="mar-pane" data-pane="review">',
            '      <button id="mar-one" class="mar-btn">一键互评（当前 1 份）</button>',
            '      <button id="mar-batch" class="mar-btn">快速互评（连续 10 份）</button>',
            '      <button id="mar-auto" class="mar-btn">全自动互评（直到完成）</button>',
            '      <button id="mar-fix" class="mar-btn">评分修复（列表检测）</button>',
            '    </div>',
            '    <div class="mar-pane" data-pane="quiz">',
            '      <button id="mar-quiz-import" class="mar-btn">导入题库（粘贴 JSON）</button>',
            '      <button id="mar-quiz-dryrun" class="mar-btn">只读演练（不点击任何选项）</button>',
            '      <button id="mar-quiz-answer" class="mar-btn">作答当前页（不交卷）</button>',
            '      <button id="mar-quiz-autosubmit" class="mar-btn mar-toggle">自动提交：关</button>',
            '      <button id="mar-quiz-probe" class="mar-btn">答题探针（采集页面结构）</button>',
            '      <button id="mar-quiz-selftest" class="mar-btn">题库自检（离线逻辑测试）</button>',
            '    </div>',
            '    <div class="mar-pane" data-pane="general">',
            '      <button id="mar-copy-unlock" class="mar-btn mar-toggle">解除复制限制：关</button>',
            '    </div>',
            '  </div>',
            '  <div id="mar-foot">',
            '    <button id="mar-stop" class="mar-btn">停止当前操作</button>',
            '    <div id="mar-status">就绪</div>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(panel);

        statusEl = document.getElementById('mar-status');

        var tabEls = panel.querySelectorAll('.mar-tab');
        for (var tb = 0; tb < tabEls.length; tb++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    switchTab(btn.getAttribute('data-tab'));
                });
            })(tabEls[tb]);
        }
        switchTab(pickDefaultTab());

        var minimized = false;
        var mainEl = document.getElementById('mar-main');
        document.getElementById('mar-minimize').addEventListener('click', function () {
            minimized = !minimized;
            mainEl.style.display = minimized ? 'none' : '';
            document.getElementById('mar-minimize').textContent = minimized ? '+' : '−';
        });

        var header = document.getElementById('mar-header');
        var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        header.addEventListener('mousedown', function (e) {
            if (e.target && e.target.id === 'mar-minimize') return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            var rect = panel.getBoundingClientRect();
            sl = rect.left; st = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panel.style.left = (sl + e.clientX - sx) + 'px';
            panel.style.top = (st + e.clientY - sy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', function () { dragging = false; });

        function guard(fn) {
            if (taskState.running) { updateStatus('正在执行中，请先停止或等待完成...'); return; }
            taskState.running = true;
            taskState.cancelled = false;
            setButtonsRunning(true);

            Promise.resolve()
                .then(fn)
                .catch(function (err) {
                    if (err && err.__cancelled) {
                        updateStatus('⏹ 已停止当前操作');
                    } else {
                        console.error('[MOOC互评] 异常', err);
                        updateStatus('发生异常：' + (err && err.message ? err.message : err));
                    }
                })
                .then(function () {
                    taskState.running = false;
                    taskState.cancelled = false;
                    setButtonsRunning(false);
                });
        }

        document.getElementById('mar-one').addEventListener('click', function () { guard(oneClickReview); });
        document.getElementById('mar-batch').addEventListener('click', function () { guard(function () { return batchReview(CONFIG.BATCH_COUNT); }); });
        document.getElementById('mar-auto').addEventListener('click', function () { guard(autoReviewAll); });
        document.getElementById('mar-fix').addEventListener('click', function () { guard(scoreFix); });
        // 复制开关不进 setButtonsRunning 的列表：它和任务状态无关，
        // 任务跑着的时候也应该能随时开关。
        document.getElementById('mar-copy-unlock').addEventListener('click', toggleCopyUnlock);
        updateCopyUnlockButton();

        document.getElementById('mar-quiz-autosubmit').addEventListener('click', toggleAutoSubmit);
        updateAutoSubmitButton();

        document.getElementById('mar-quiz-import').addEventListener('click', function () { guard(importBankPrompt); });
        document.getElementById('mar-quiz-dryrun').addEventListener('click', function () { guard(runQuizDryRun); });
        document.getElementById('mar-quiz-answer').addEventListener('click', function () { guard(runQuizAnswer); });
        document.getElementById('mar-quiz-probe').addEventListener('click', function () { guard(quizProbe); });
        document.getElementById('mar-quiz-selftest').addEventListener('click', function () {
            guard(function () {
                var r = quizSelfTest();
                var failed = r.lines.filter(function (l) { return l.indexOf('❌') === 0; });
                // 有失败项时直接把明细摊开，省得再去翻 console
                if (failed.length) showTextOverlay('题库自检 · ' + r.summary, r.lines.join('\n'));
            });
        });
        document.getElementById('mar-stop').addEventListener('click', function () {
            if (!taskState.running) return;
            taskState.cancelled = true;
            updateStatus('⏹ 正在停止...');
        });

        updateTabAlert();
        // 初始收起停止按钮：面板刚出现时没有任务在跑
        setButtonsRunning(false);
    }

    // ===================== 初始化 =====================
    function init() {
        // 网络探针必须在页面加载时就装好：装晚了页面自己的请求已经发完，
        // 抓不到任何东西（第一次采集就是这样，network 是空的）。
        if (CONFIG.QUIZ_PROBE_AUTOSTART) installNetworkProbe();
        // 恢复上次的复制开关状态（页面刷新后不用再点一次）
        applyCopyUnlock(isCopyUnlockOn());
        createFloatingPanel();
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 1000);
    } else {
        window.addEventListener('load', function () { setTimeout(init, 1000); });
    }
})();
