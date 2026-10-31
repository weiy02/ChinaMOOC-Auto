// ==UserScript==
// @name         中国大学MOOC-自动化
// @namespace    https://github.com/weiy02/ChinaMOOC-Auto
// @version      1.10.0
// @description  中国大学MOOC学生互评自动化：解析真实分值选最高分，评语“科技改变生活”，答题者不可见。支持停止、评分修复；课堂讨论自动回复（适配新版UI，含页面DOM诊断）；随堂测验一键作答并提交（从课件接口取正确答案，逐题比对填涂）；自动学习（新版DOM导航：tab内容标签+章节/小节下拉模拟点击；测验自动跳过、富文本停留10秒自动跳）：从当前内容开始→视频从头播放→完成后进入本章下一个内容（文档每页1秒自动翻页，含新版缩略图阅读器；讨论自动回复；连续视频自动跳过；视频中弹出的题目自动作答，答对自动继续、答错需手动点击播放）。
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

        // ---- 课堂讨论自动回复 ----
        // 回复正文的长度上限。别人的答复可能是长篇大论，整段照搬既显眼又容易
        // 触发字数限制，超过就从句子边界截断。
        DISCUSS_MAX_LEN: 200,
        // 比这更短的正文不当作“答复”看待（多半是「已删除」「图片」之类的占位）
        DISCUSS_MIN_LEN: 2,
        // 单条讨论最多解析多少个答复，防止楼层上千时卡住
        DISCUSS_MAX_ITEMS: 300,
        // 已回复记录最多留多少条（按讨论标题 + 页面地址去重）
        DISCUSS_HISTORY_MAX: 300,
        // 填入编辑器后到点「发布」之间的等待，给富文本框架留出同步时间
        DISCUSS_FILL_WAIT: 600,

        // ---- 自动学习（新版学习页 #/learn/content?type=detail&id=xxx）----
        LEARN_DOC_PAGE_MS: 1000,        // 文档每页停留 1 秒（用户要求）
        LEARN_NAV_WAIT: 5000,           // 切换内容后的加载等待上限
        LEARN_QUIZ_RESUME_WAIT: 8000,   // 提交视频弹题后，等待视频自动恢复播放的最长时间
        LEARN_QUIZ_VISIT_MS: 2500,      // （测验改为直接跳过，不再停留；此值保留作兜底）
        LEARN_OTHER_VISIT_MS: 10000,    // 富文本等其它内容停留 10 秒后自动跳转（用户要求）
        LEARN_VIDEO_END_MARGIN: 1.5,    // 距视频结尾还剩多少秒视为“已看完”
        LEARN_CONTENT_READY_WAIT: 15000, // 内容加载就绪的最大等待时间（修复“没加载完就跳转”）
        LEARN_IDLE_POLL: 600,           // 视频监控轮询间隔（毫秒）
        LEARN_MAX_PAGE_FLIPS: 600,      // 单个文档最多翻多少页（保险上限）
        LEARN_MAX_ITEMS: 200,           // 单章最多处理多少内容（保险上限）
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
            '.u-questionItem, .m-choiceQuestion, .m-subjectiveQuestion, .m-fillblankQuestion, .j-questionItem, ' +
            '[class*="questionItem"], [class*="question-item"], [class*="choiceQuestion"], [class*="fillblankQuestion"], ' +
            '[class*="fillblank"], [class*="judgeQuestion"], [class*="objectiveQuestion"], [class*="testItem"]'
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

    // 带提前退出的等待：early() 返回 true（如用户点了【下一节】）时立即结束
    function sleepWhile(ms, early) {
        return new Promise(function (resolve, reject) {
            var start = Date.now();
            function tick() {
                if (taskState.cancelled) { reject(makeCancelError()); return; }
                if (Date.now() - start >= ms || (typeof early === 'function' && early())) { resolve(); return; }
                setTimeout(tick, 250);
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

    // ===================== 本地存储 =====================
    // 只有 localStorage 一条来源。读写都要吞掉异常：隐私模式下 localStorage
    // 会直接抛，而存的是开关状态和回复留痕这类非关键数据，不能因为存不下就崩。
    function readStore(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            console.warn('[MOOC助手] 读取本地存储失败', key, e);
            return fallback;
        }
    }

    function writeStore(key, val) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            return true;
        } catch (e) {
            console.warn('[MOOC助手] 写入本地存储失败', key, e);
            return false;
        }
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

    // ===================== 课堂讨论：自动回复 =====================
    // 从「已经有人回复过的区域」里挑一条现成答复作为回复正文。
    // 两种来源：最新的一条 / 点赞最多的一条，默认最新，可在「设置」里切换。
    //
    // 与互评同一套安全原则：
    //   1. 选不出正文就什么都不做——绝不拿占位文本凑数，也绝不自己编内容
    //   2. 同一条讨论只回复一次（本地留痕），防止重复刷屏
    //   3. 只写「回复输入框」，不碰页面上其它可编辑区
    //   4. 提供预览，先让人看见要发出去的是什么，再决定发不发
    var DISCUSS = {
        KEY_SOURCE: 'mar.discuss.source',
        KEY_HISTORY: 'mar.discuss.history',

        SOURCE_LATEST: 'latest',
        SOURCE_LIKED: 'liked',

        // 已回复区域的容器：命中任一且能解析出答复就采用，数组顺序即优先级
        listSelectors: [
            '[class*="reply-list"]', '[class*="replyList"]', '[class*="reply_list"]',
            '[class*="comment-list"]', '[class*="commentList"]', '[class*="comment_list"]',
            '[class*="post-list"]', '[class*="postList"]',
            '[class*="answer-list"]', '[class*="answerList"]',
            '[class*="discuss-list"]', '[class*="discussion-list"]',
            '[class*="forum-list"]', '[class*="reply-area"]', '[class*="replyArea"]',
            '[class*="comment-area"]', '[class*="topic-reply"]',
            '.j-replyList', '.m-replyList', '.j-commentList', '.m-commentList',
            '.j-comment-list', '.reply-list', '.comment-list', '.j-comment-list-wrapper',
            '.replies-wrapper', '[class*="replies"]', '[class*="topic-replies"]',
            // 新版 UI（mooc- 前缀，BEM 命名）
            '[class*="mooc-comment"]', '[class*="mooc-discuss"]', '[class*="mooc-reply"]',
            '[class*="mooc-comment__list"]', '[class*="mooc-discuss__list"]', '[class*="mooc-reply__list"]',
        ],

        // 容器之内的楼层节点
        itemSelectors: [
            '[class*="reply-item"]', '[class*="replyItem"]',
            '[class*="comment-item"]', '[class*="commentItem"]',
            '[class*="post-item"]', '[class*="postItem"]',
            '[class*="answer-item"]', '[class*="answerItem"]',
            '[class*="discuss-item"]', '[class*="discussion-item"]',
            '[class*="floor"]', '[class*="reply-card"]', '[class*="replyCard"]',
            '.j-reply-item', '.reply-item', '.j-comment-item', '.reply-container', '.reply-main',
            // 新版 UI
            '[class*="mooc-comment__item"]', '[class*="mooc-discuss__item"]', '[class*="mooc-reply__item"]',
            '[class*="mooc-comment-item"]', '[class*="mooc-discuss-item"]', '[class*="mooc-reply-item"]',
            'li', '.item',
        ],

        // 楼层里的正文节点，按顺序优先（越靠前越像“正文”本身）
        contentSelectors: [
            '[class*="reply-content"]', '[class*="replyContent"]',
            '[class*="comment-content"]', '[class*="commentContent"]',
            '[class*="post-content"]', '[class*="postContent"]',
            '[class*="answer-content"]', '[class*="answerContent"]',
            '[class*="reply-text"]', '[class*="comment-text"]', '[class*="post-text"]',
            '[class*="content"]', '[class*="text"]', '[class*="body"]', '[class*="desc"]',
            '.reply-content', '.j-reply-content', '.j-topic-content', '.topic-content',
            '[class*="article-content"]',
            // 新版 UI
            '[class*="mooc-comment__content"]', '[class*="mooc-discuss__content"]', '[class*="mooc-reply__content"]',
            '[class*="mooc-comment__text"]', '[class*="mooc-comment-content"]',
            'p',
        ],

        // 点赞数所在节点
        likeSelectors: [
            '[class*="like"]', '[class*="praise"]', '[class*="thumb"]',
            '[class*="vote"]', '[class*="agree"]', '[class*="zan"]', '[class*="up-count"]',
            '.j-icon-up', '.u-icon-vote', '.j-num',
            '[class*="mooc-comment__like"]', '[class*="mooc-comment__vote"]', '[class*="mooc-like"]', '[class*="mooc-vote"]',
        ],

        // 时间所在节点
        timeSelectors: [
            'time', '[class*="time"]', '[class*="date"]', '[class*="create"]', '[class*="publish"]',
            '.reply-item-info', '[class*="replyInfo"]',
        ],

        // 编辑器所在作用域：先在这些容器里找输入框，找不到才看整页
        editorScopeSelectors: [
            '[class*="reply-editor"]', '[class*="replyEditor"]', '[class*="reply-input"]',
            '[class*="comment-editor"]', '[class*="comment-input"]', '[class*="post-editor"]',
            '[class*="editor"]', '[class*="reply-box"]', '[class*="replyBox"]',
            '[class*="comment-box"]', '[class*="reply-area"]', '[class*="replyArea"]',
            '[class*="discuss"]', '[class*="forum"]', 'form',
            '.j-editor-wrapper', '[class*="editor-textarea"]', '.editor-textarea', '.reply-editor',
            // 新版 UI
            '[class*="mooc-comment"]', '[class*="mooc-discuss"]', '[class*="mooc-reply"]',
            '[class*="mooc-comment__editor"]', '[class*="mooc-comment__input"]', '[class*="mooc-comment__submit"]',
        ],

        // 发布按钮：整串相等才算，避免误点到楼层的「回复」小链接
        submitText: /^(发布|发表|回复|提交|发送|评论|发表回复|发布回复|提交回复|提交答案|发表评论|发布评论|确定)$/,
        // 输入框里的占位提示。看到这类文本要当成“空的”，可以直接覆盖
        placeholderText: /请输入|说点什么|写下|来说两句|回复一下|发表你的|添加回复|写回复|期待你的|分享你的/,
        // 元信息节点（作者名 / 时间 / 点赞条），正文提取时要避开
        metaClass: /name|author|user|avatar|nick|time|date|like|praise|vote|agree|tool|oper|action/i,
    };

    function getDiscussSource() {
        var v = readStore(DISCUSS.KEY_SOURCE, DISCUSS.SOURCE_LATEST);
        return (v === DISCUSS.SOURCE_LIKED) ? DISCUSS.SOURCE_LIKED : DISCUSS.SOURCE_LATEST;
    }

    function setDiscussSource(v) {
        writeStore(DISCUSS.KEY_SOURCE, v === DISCUSS.SOURCE_LIKED ? DISCUSS.SOURCE_LIKED : DISCUSS.SOURCE_LATEST);
        updateSourceSeg();
    }

    function sourceLabel(v) {
        return v === DISCUSS.SOURCE_LIKED ? '点赞最多' : '最新答复';
    }

    // ===================== 课堂讨论：解析已回复区域 =====================
    // 多选择器取并集并按数组顺序去重。单个选择器经常只能覆盖一种版式，
    // 全站还有好几套模板，所以是「并集 + 优先级」而不是「命中一个就走」。
    function collectCandidates(scope, selectors, limit) {
        var out = [], seen = [];
        for (var s = 0; s < selectors.length && out.length < limit; s++) {
            var found;
            try { found = scope.querySelectorAll(selectors[s]); } catch (e) { continue; }
            for (var i = 0; i < found.length && out.length < limit; i++) {
                if (seen.indexOf(found[i]) !== -1) continue;
                seen.push(found[i]);
                out.push(found[i]);
            }
        }
        return out;
    }

    // 只保留最外层：楼层里嵌套的子回复会被反复统计，也会让正文串成一大坨
    function keepOutermost(els) {
        return els.filter(function (el) {
            for (var i = 0; i < els.length; i++) {
                if (els[i] !== el && els[i].contains(el)) return false;
            }
            return true;
        });
    }

    function cleanText(s) {
        return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    }

    function isPlaceholderText(t) {
        return !t || DISCUSS.placeholderText.test(t);
    }

    function firstNumberInText(text) {
        var m = String(text || '').match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
    }

    function readAttrNumber(el, attrs) {
        for (var i = 0; i < attrs.length; i++) {
            var v = el.getAttribute ? el.getAttribute(attrs[i]) : null;
            if (!v) continue;
            var n = parseFloat(v);
            if (!isNaN(n)) return n;
        }
        return null;
    }

    // 楼层里的点赞数。取「属性优先、文本兜底、多条取最大」，
    // 认不出来时返回 null（而不是 0），好让上层区分「0 个赞」和「没解析到」。
    function readLikeCount(item) {
        var els = collectCandidates(item, DISCUSS.likeSelectors, 30);
        var best = null;
        for (var i = 0; i < els.length; i++) {
            var n = readAttrNumber(els[i], ['data-count', 'data-num', 'data-number', 'data-like', 'data-praise', 'data-total']);
            if (n === null) n = readAttrNumber(els[i], ['title', 'aria-label']);
            if (n === null) n = firstNumberInText(els[i].textContent);
            if (n === null || isNaN(n)) continue;
            if (best === null || n > best) best = n;
        }
        return best;
    }

    // 时间只用于排序，解析不出来返回 null，上层会退化成按页面顺序排
    function parseTimeToMs(text) {
        var s = cleanText(text);
        if (!s) return null;
        var now = Date.now(), m;

        m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (m) {
            return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
                parseInt(m[4] || 0, 10), parseInt(m[5] || 0, 10), parseInt(m[6] || 0, 10)).getTime();
        }
        m = s.match(/(\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
        if (m) {
            var mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
                var dt = new Date(new Date().getFullYear(), mo - 1, d,
                    parseInt(m[3] || 0, 10), parseInt(m[4] || 0, 10));
                // 落在未来一年以上说明是去年的贴子，往回拨一年
                if (dt.getTime() > now + 86400000) dt.setFullYear(dt.getFullYear() - 1);
                return dt.getTime();
            }
        }
        m = s.match(/(\d+)\s*(秒|分钟|分|小时|天|周|个月|月)前/);
        if (m) {
            var unit = { '秒': 1000, '分钟': 60000, '分': 60000, '小时': 3600000, '天': 86400000, '周': 604800000, '个月': 2592000000, '月': 2592000000 };
            return now - parseInt(m[1], 10) * (unit[m[2]] || 0);
        }
        if (/刚刚|刚才/.test(s)) return now;
        if (/昨天/.test(s)) return now - 86400000;
        if (/前天/.test(s)) return now - 2 * 86400000;
        return null;
    }

    function readTimeInfo(item) {
        var els = collectCandidates(item, DISCUSS.timeSelectors, 20);
        for (var i = 0; i < els.length; i++) {
            var attr = els[i].getAttribute ? els[i].getAttribute('datetime') : null;
            if (attr) {
                var fromAttr = parseTimeToMs(attr);
                if (fromAttr !== null) return { text: cleanText(els[i].textContent) || attr, ts: fromAttr };
            }
            var t = cleanText(els[i].textContent);
            if (!t) continue;
            var ts = parseTimeToMs(t);
            if (ts !== null) return { text: t, ts: ts };
            if (i === 0) return { text: t, ts: null };
        }
        return { text: '', ts: null };
    }

    // 正文节点判定：作者名 / 时间 / 点赞条这些元信息不是正文，
    // 误取它们会把「张三 2026-10-11 12」当回复发出去。
    function looksLikeMeta(el) {
        var cls = (typeof el.className === 'string') ? el.className : '';
        if (DISCUSS.metaClass.test(cls)) return true;
        return !!(el.closest && el.closest('time, [class*="time"], [class*="like"], [class*="praise"]'));
    }

    function pickContent(el) {
        var cands = collectCandidates(el, DISCUSS.contentSelectors, 40);
        var viable = [], i;
        for (i = 0; i < cands.length; i++) {
            var t = cleanText(cands[i].textContent);
            if (t.length < CONFIG.DISCUSS_MIN_LEN || t.length > 1500) continue;
            if (isPlaceholderText(t)) continue;
            viable.push(cands[i]);
        }
        var pool = [];
        for (i = 0; i < viable.length; i++) {
            if (!looksLikeMeta(viable[i])) pool.push(viable[i]);
        }
        if (pool.length === 0) pool = viable;

        if (pool.length === 0) {
            // 没有正文型子节点时退到整层文本，但只在长度合理时接受
            var self = cleanText(el.textContent);
            if (self.length >= CONFIG.DISCUSS_MIN_LEN && self.length <= 1500 && !isPlaceholderText(self)) {
                return { text: self, viaContent: false };
            }
            return null;
        }
        // 取最长的：同一层里可能有摘要、折叠态之类的短副本
        var best = pool[0], bestLen = cleanText(pool[0].textContent).length;
        for (i = 1; i < pool.length; i++) {
            var len = cleanText(pool[i].textContent).length;
            if (len > bestLen) { best = pool[i]; bestLen = len; }
        }
        return { text: cleanText(best.textContent), viaContent: true };
    }

    // 单条楼层 → 结构化记录。strict 时要求必须命中正文节点（整页兜底模式用，
    // 否则满屏的 li 都会被当成回复）
    function parseReplyItem(el, index, strict) {
        var content = pickContent(el);
        if (!content) return null;
        if (strict && !content.viaContent) return null;
        var time = readTimeInfo(el);
        return {
            el: el,
            index: index,
            text: content.text,
            likes: readLikeCount(el),
            timeText: time.text,
            ts: time.ts,
            viaContent: content.viaContent,
        };
    }

    function parseReplyItems() {
        var lists = collectCandidates(document, DISCUSS.listSelectors, 40);
        var i, items;
        for (i = 0; i < lists.length; i++) {
            var raw = keepOutermost(collectCandidates(lists[i], DISCUSS.itemSelectors, CONFIG.DISCUSS_MAX_ITEMS));
            items = [];
            for (var j = 0; j < raw.length; j++) {
                var it = parseReplyItem(raw[j], items.length, false);
                if (it) items.push(it);
            }
            if (items.length > 0) {
                console.log('[MOOC讨论] 命中容器 ' + lists[i].className + '，解析到 ' + items.length + ' 条答复');
                return { items: items, listEl: lists[i], viaList: true };
            }
        }
        // 容器全没命中：整页兜底，此时必须命中正文节点才算数
        var fallback = keepOutermost(collectCandidates(document, DISCUSS.itemSelectors, CONFIG.DISCUSS_MAX_ITEMS));
        items = [];
        for (i = 0; i < fallback.length; i++) {
            var f = parseReplyItem(fallback[i], items.length, true);
            if (f) items.push(f);
        }
        if (items.length > 0) {
            console.log('[MOOC讨论] 未命中已知容器，整页兜底解析到 ' + items.length + ' 条答复');
        }
        // 最后一招：按“点赞/投票元素”反查楼层。新版 UI 若改了楼层类名，
        // 只要点赞图标还在，就能兜住大部分版式。
        if (items.length === 0) {
            var votes = document.querySelectorAll('[class*="vote"], [class*="like"], [class*="zan"], [class*="praise"], [class*="thumb"], .j-icon-up');
            var seenFloor = [];
            for (i = 0; i < votes.length && items.length < CONFIG.DISCUSS_MAX_ITEMS; i++) {
                if (!isVisible(votes[i])) continue;
                var floor = votes[i].closest
                    ? votes[i].closest('[class*="reply"], [class*="comment"], [class*="post"], [class*="discuss"], [class*="floor"], li, .item')
                    : null;
                if (!floor || seenFloor.indexOf(floor) !== -1) continue;
                var it = parseReplyItem(floor, items.length, true);
                if (it) { seenFloor.push(floor); items.push(it); }
            }
            if (items.length > 0) {
                console.log('[MOOC讨论] 点赞元素反查楼层，解析到 ' + items.length + ' 条答复');
            }
        }
        return { items: items, listEl: null, viaList: false };
    }

    // 按来源挑一条。返回 note 说明是怎么挑的，方便人对着预览判断靠不靠谱。
    function pickSourceReply(items, source) {
        if (!items || items.length === 0) return null;

        function byNewest(a, b) {
            var ta = a.ts === null ? -Infinity : a.ts;
            var tb = b.ts === null ? -Infinity : b.ts;
            if (ta !== tb) return tb - ta;
            return b.index - a.index;
        }

        if (source === DISCUSS.SOURCE_LIKED) {
            var liked = items.filter(function (it) { return it.likes !== null && it.likes > 0; });
            if (liked.length === 0) {
                var fb = items.slice().sort(byNewest)[0];
                return {
                    item: fb,
                    note: '本页没解析到点赞数，已退回「最新答复」'
                };
            }
            liked.sort(function (a, b) {
                if (b.likes !== a.likes) return b.likes - a.likes;
                return byNewest(a, b);
            });
            return { item: liked[0], note: '取自点赞最多的答复（' + liked[0].likes + ' 个赞）' };
        }

        var sorted = items.slice().sort(byNewest);
        var anyTs = sorted.some(function (it) { return it.ts !== null; });
        return {
            item: sorted[0],
            note: anyTs ? '取自时间最新的答复' : '没能解析出楼层时间，按页面顺序取最后一条'
        };
    }

    // 超长就截到句子边界——整段照搬既显眼，又容易撞上站点字数上限
    function clipReplyText(s) {
        var t = cleanText(s);
        var max = CONFIG.DISCUSS_MAX_LEN;
        if (t.length <= max) return t;
        var cut = t.slice(0, max);
        var idx = -1, marks = ['。', '！', '？', '；', '. ', '! ', '? '];
        for (var i = 0; i < marks.length; i++) {
            var p = cut.lastIndexOf(marks[i]);
            if (p > idx) idx = p;
        }
        if (idx > max * 0.4) cut = cut.slice(0, idx + 1);
        return cut;
    }

    // ===================== 课堂讨论：编辑器与发布 =====================
    function isEditable(el) {
        if (!el || !isVisible(el)) return false;
        if (el.disabled || el.readOnly) return false;
        var tag = String(el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') return String(el.type || '').toLowerCase() === 'text';
        var ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
        return ce !== null && ce !== 'false';
    }

    // 「空的」= 没内容，或只有占位提示。点开编辑区后站点常把提示写进 DOM，
    // 不识别就会以为已经有人写过而跳过。
    function isEmptyEditor(el) {
        var tag = String(el.tagName || '').toUpperCase();
        var v = (tag === 'TEXTAREA' || tag === 'INPUT') ? (el.value || '') : (el.textContent || '');
        v = cleanText(v);
        if (!v) return true;
        return isPlaceholderText(v);
    }

    function findEditorsIn(scope) {
        var out = [];
        var els = scope.querySelectorAll('textarea, input[type="text"], [contenteditable]');
        for (var i = 0; i < els.length; i++) {
            if (isEditable(els[i]) && isEmptyEditor(els[i])) out.push(els[i]);
        }
        return out;
    }

    // 先在「回复区」作用域里找，找不到再看整页。
    // 顺序很重要：页面上可能有搜索框、笔记框等其它可编辑区，
    // 直接全页扫第一个输入框会写错地方。
    function findReplyEditor() {
        var scopes = collectCandidates(document, DISCUSS.editorScopeSelectors, 40);
        var i, found;
        for (i = 0; i < scopes.length; i++) {
            found = findEditorsIn(scopes[i]);
            if (found.length > 0) return found[0];
        }
        found = findEditorsIn(document);
        return found.length > 0 ? found[0] : null;
    }

    function fillEditor(el, value) {
        var tag = String(el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
            setNativeValue(el, value);
            return (el.value || '').indexOf(value) !== -1;
        }
        el.focus();
        // 先全选，再走浏览器原生的 insertText 路径：直接改 textContent
        // 常常被富文本框架忽略，点发布时它读到的还是旧值
        var sel = window.getSelection();
        if (sel) {
            var range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        var ok = false;
        try { ok = document.execCommand('insertText', false, value); } catch (e) { ok = false; }
        if (!ok || cleanText(el.textContent).indexOf(cleanText(value)) === -1) {
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return cleanText(el.textContent).length > 0;
    }

    // 发布按钮。从编辑器往上爬若干层先找（发布按钮多半和输入框同属一个表单），
    // 全页兜底时跳过「落在某个楼层里」的按钮——那通常是楼层自己的「回复」小链接。
    function findSubmitButton(editor, items) {
        var scope = editor, up = 0;
        while (scope && up < 6) {
            var btn = findButtonIn(scope);
            if (btn) return btn;
            scope = scope.parentElement;
            up++;
        }
        var all = document.querySelectorAll('button, a, div[role="button"], input[type="submit"], span[role="button"]');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (!isVisible(el) || el.disabled) continue;
            var t = cleanText(el.textContent || el.value || '');
            if (!t || t.length > 6) continue;
            if (!DISCUSS.submitText.test(t)) continue;
            if (insideAnyItem(el, items)) continue;
            return el;
        }
        return null;
    }

    function findButtonIn(scope) {
        if (!scope || !scope.querySelectorAll) return null;
        var els = scope.querySelectorAll('button, a, div[role="button"], input[type="submit"], span[role="button"]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el) || el.disabled) continue;
            var t = cleanText(el.textContent || el.value || '');
            if (!t || t.length > 6) continue;
            if (DISCUSS.submitText.test(t)) return el;
        }
        return null;
    }

    function insideAnyItem(el, items) {
        if (!items) return false;
        for (var i = 0; i < items.length; i++) {
            if (items[i].el && items[i].el.contains(el)) return true;
        }
        return false;
    }

    // ===================== 课堂讨论：去重留痕 =====================
    function discussionKey() {
        var t = '';
        var h = document.querySelector('h1, [class*="topic-title"], [class*="discuss-title"], [class*="detail-title"], [class*="title"]');
        if (h) t = cleanText(h.textContent).slice(0, 80);
        if (!t) t = cleanText(document.title).slice(0, 80);
        return t + '|' + location.href;
    }

    function getDiscussHistory() {
        var h = readStore(DISCUSS.KEY_HISTORY, []);
        return (h instanceof Array) ? h : [];
    }

    function alreadyReplied(key) {
        var h = getDiscussHistory();
        for (var i = 0; i < h.length; i++) {
            if (h[i] && h[i].key === key) return h[i].at;
        }
        return null;
    }

    function rememberReplied(key, text) {
        var h = getDiscussHistory();
        h.unshift({ key: key, at: Date.now(), text: String(text || '').slice(0, 60) });
        if (h.length > CONFIG.DISCUSS_HISTORY_MAX) h = h.slice(0, CONFIG.DISCUSS_HISTORY_MAX);
        writeStore(DISCUSS.KEY_HISTORY, h);
    }

    function clearDiscussHistory() {
        writeStore(DISCUSS.KEY_HISTORY, []);
        updateStatus('🧹 已清除回复记录，同一条讨论可以再次回复');
    }

    // ===================== 课堂讨论：主流程 =====================
    // 只做「挑内容」这一件事，回复和预览都复用它
    function resolveReplyContent() {
        var parsed = parseReplyItems();
        if (parsed.items.length === 0) {
            return { ok: false, error: '未解析到已回复的内容，请确认当前页面是课堂讨论页且已有人回复' };
        }
        var source = getDiscussSource();
        var picked = pickSourceReply(parsed.items, source);
        if (!picked || !picked.item) {
            return { ok: false, error: '已回复区域里没有可用的正文' };
        }
        return {
            ok: true,
            items: parsed.items,
            item: picked.item,
            note: picked.note,
            source: source,
            viaList: parsed.viaList,
            text: clipReplyText(picked.item.text),
        };
    }

    function previewReply() {
        var r = resolveReplyContent();
        if (!r.ok) { updateStatus('❌ ' + r.error); return; }
        var lines = [];
        lines.push('内容来源：' + sourceLabel(r.source) + '（' + r.note + '）');
        lines.push('楼层总数：' + r.items.length + ' 条'
            + (r.viaList ? '' : '   ⚠️ 未命中已知的回复列表容器，为整页兜底解析结果'));
        lines.push('选中楼层：第 ' + (r.item.index + 1) + ' 条'
            + (r.item.likes !== null ? '，点赞 ' + r.item.likes : '，点赞数未解析到')
            + (r.item.timeText ? '，时间 ' + r.item.timeText : ''));
        lines.push('');
        lines.push('=== 将要回复的内容 ===');
        lines.push(r.text);
        showTextOverlay('回复预览 · 尚未发布', lines.join('\n'));
        updateStatus('🔎 已预览：' + sourceLabel(r.source) + '，共 ' + r.items.length + ' 条答复可选');
    }

    async function replyDiscussion() {
        var r = resolveReplyContent();
        if (!r.ok) { updateStatus('❌ ' + r.error); return; }

        var key = discussionKey();
        var at = alreadyReplied(key);
        if (at) {
            updateStatus('⏭ 这条讨论已于 ' + new Date(at).toLocaleString() + ' 回复过，跳过（可在设置里清除记录）');
            return;
        }

        updateStatus('正在定位回复输入框...');
        // 很多站点的输入框要先点一下才会展开真正的编辑区和「发布」按钮
        var probeEditor = findReplyEditor();
        if (probeEditor) realClick(probeEditor);
        await sleep(CONFIG.DELAY_AFTER_CLICK);

        var editor = findReplyEditor();
        if (!editor) { updateStatus('❌ 未找到可用的回复输入框'); return; }

        updateStatus('正在填入内容（' + sourceLabel(r.source) + '）...');
        var filled = fillEditor(editor, r.text);
        if (!filled) { updateStatus('❌ 内容填入失败，未发布任何内容'); return; }
        await sleep(CONFIG.DISCUSS_FILL_WAIT);

        var btn = findSubmitButton(editor, r.items);
        if (!btn) {
            updateStatus('⚠️ 内容已填入输入框，但没找到发布按钮，请手动点击发布');
            return;
        }

        updateStatus('正在发布回复...');
        realClick(btn);
        await sleep(CONFIG.DELAY_AFTER_SUBMIT);
        await dismissModal();

        rememberReplied(key, r.text);
        updateStatus('✅ 已回复（' + sourceLabel(r.source) + ' · ' + r.note + '）');
    }

    // 页面是否像讨论页：用于决定面板默认打开哪个选项卡。
    // 判定要偏严。这里只看「回复列表容器」和「多行输入框 / 富文本输入框」，
    // 不把单行 input 算进去——搜索框、筛选框满页都是，算上会几乎永远为真。
    function hasDiscussion() {
        if (collectCandidates(document, DISCUSS.listSelectors, 10).length > 0) return true;
        var els = document.querySelectorAll('textarea, [contenteditable="true"]');
        for (var i = 0; i < els.length; i++) {
            if (isVisible(els[i])) return true;
        }
        return false;
    }

    // 通用文本浮层：回复预览、诊断报告共用。
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
    // ===================== 状态栏 & 按钮 =====================
    var statusEl = null;
    // ===================== 开发者调试日志 =====================
    // 目的：记录「检测到了什么、走到了哪一步、为什么这样决策」，
    // 便于开发者排查问题（不是给使用者看完成情况）。面板「日志」页签可查看/复制/清空。
    var debugLogs = [];
    var DEBUG_LOG_MAX = 500;      // 内存里最多保留多少条，超出丢最旧
    var DEBUG_LOG_SHOW = 120;     // 面板里最多展示多少条

    // 追加一条调试日志。cat 是分类标签（type/nav/menu/learn/video/doc/quiz/status/err…）
    function logDebug(cat, msg) {
        var t = new Date();
        var ts = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2) + '.' + ('00' + t.getMilliseconds()).slice(-3);
        debugLogs.push({ t: ts, cat: cat, msg: String(msg || '') });
        if (debugLogs.length > DEBUG_LOG_MAX) debugLogs.splice(0, debugLogs.length - DEBUG_LOG_MAX);
        try { console.log('[MOOC:' + cat + ']', ts, msg); } catch (e) {}
        refreshLogBox();
    }

    // 把日志渲染进面板（只在日志页签可见时渲染，避免高频操作拖慢页面）
    function escHtml(s) {
        return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function refreshLogBox() {
        var box = document.getElementById('mar-log-box');
        if (!box || !box.parentElement.classList.contains('mar-active')) return;
        var frag = [];
        var start = Math.max(0, debugLogs.length - DEBUG_LOG_SHOW);
        for (var i = start; i < debugLogs.length; i++) {
            var l = debugLogs[i];
            frag.push('<div class="mar-log-line"><span class="mar-log-t">' + l.t + '</span>[<span class="mar-log-cat">' + l.cat + '</span>] ' + escHtml(l.msg) + '</div>');
        }
        box.innerHTML = frag.length ? frag.join('') : '<div class="mar-log-empty">（暂无日志）</div>';
        try { box.scrollTop = box.scrollHeight; } catch (e) {}
    }

    function clearDebugLogs() {
        debugLogs = [];
        refreshLogBox();
    }

    // 复制日志到剪贴板（格式：时间 [分类] 消息，每行一条）
    function copyDebugLogs() {
        var text = debugLogs.map(function (l) { return l.t + ' [' + l.cat + '] ' + l.msg; }).join('\n');
        if (!text) { updateStatus('暂无日志可复制'); return; }
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            updateStatus('✅ 已复制 ' + debugLogs.length + ' 条日志');
        } catch (e) {
            showTextOverlay('调试日志', text);
            updateStatus('已用浮层展示日志（复制失败）');
        }
    }

    function updateStatus(msg) {
        if (statusEl) statusEl.textContent = msg;
        logDebug('status', msg);
    }

    // 按选择器收集而不是硬编码 id 列表。原来那份硬编码清单是个持续的坑：
    // 每加一个按钮都得记得往数组里补一条，漏了就变成「运行期间还能点」。
    function setButtonsRunning(isRunning) {
        var btns = document.querySelectorAll('#mooc-auto-review-panel .mar-btn');
        for (var i = 0; i < btns.length; i++) {
            var el = btns[i];
            if (el.id === 'mar-stop') continue;
            // 开关类按钮（解除复制）与任务状态无关，
            // 任务跑着的时候也应该能随时切换
            if (el.classList.contains('mar-toggle')) continue;
            // 日志按钮同理：跑着的时候也需要能复制/清空日志排查问题
            if (el.id === 'mar-log-copy' || el.id === 'mar-log-clear') continue;
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
            '#mar-discuss-preview::before { background: #0ea5e9; }',
            '#mar-discuss-reply::before   { background: #22c55e; }',
            '#mar-learn-start::before    { background: #f97316; }',
            '#mar-lesson-quiz::before    { background: #6366f1; }',
            '#mar-learn-probe::before    { background: #14b8a6; }',
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
            '#mar-copy-unlock::before { background: #64748b; }',
            // 日志框：等宽小字 + 可滚动 + 底部自动跟随
            '.mar-log-box {',
            '  height: 150px; overflow-y: auto;',
            '  padding: 6px 8px; border-radius: 10px;',
            '  background: rgba(15, 20, 40, 0.92);',
            '  border: 1px solid rgba(255, 255, 255, 0.18);',
            '  font-family: Menlo, Consolas, "SF Mono", monospace;',
            '  font-size: 10.5px; line-height: 1.45;',
            '  color: #d6dbe6; white-space: pre-wrap; word-break: break-all;',
            '}',
            '.mar-log-line { margin: 1px 0; }',
            '.mar-log-t { color: #8b93a7; margin-right: 4px; }',
            '.mar-log-cat { color: #7dd3fc; font-weight: 600; }',
            '.mar-log-empty { color: #8b93a7; padding: 8px 2px; }',
            // 开启态：绿点 + 淡绿底，一眼能看出复制限制现在是解开的
            '#mar-copy-unlock.mar-on::before { background: #22c55e; }',
            '#mar-copy-unlock.mar-on:not(:disabled) {',
            '  color: #15803d; background: rgba(226, 252, 235, 0.6);',
            '  border-color: rgba(160, 230, 190, 0.85);',
            '}',
            '#mar-copy-unlock.mar-on:hover:not(:disabled) { background: rgba(214, 250, 226, 0.88); }',
            // 设置项：一行标题 + 下面一行二选一的分段控件
            '.mar-field {',
            '  display: flex; flex-direction: column; gap: 6px;',
            '  padding: 9px 11px; border-radius: 11px;',
            '  background: rgba(255, 255, 255, 0.3);',
            '  border: 1px solid rgba(255, 255, 255, 0.55);',
            '  box-shadow: inset 0 1px 2px rgba(15, 20, 40, 0.04);',
            '}',
            '.mar-label { font-size: 11.5px; font-weight: 600; color: #3a3a3c; }',
            '.mar-hint { font-size: 10.5px; line-height: 1.45; color: #7a7a80; }',
            '.mar-seg {',
            '  display: flex; gap: 3px; padding: 3px;',
            '  border-radius: 9px;',
            '  background: rgba(255, 255, 255, 0.3);',
            '  border: 1px solid rgba(255, 255, 255, 0.6);',
            '}',
            '.mar-seg-btn {',
            '  flex: 1; padding: 6px 4px;',
            '  border: 1px solid transparent; border-radius: 7px;',
            '  background: transparent;',
            '  font-family: inherit; font-size: 11.5px; font-weight: 500;',
            '  color: #7a7a80; cursor: pointer;',
            '  transition: color 0.16s ease, background 0.16s ease;',
            '}',
            '.mar-seg-btn:hover:not(.mar-active) { color: #1c1c1e; background: rgba(255, 255, 255, 0.4); }',
            '.mar-seg-btn.mar-active {',
            '  color: #1c1c1e; font-weight: 600;',
            '  background: rgba(255, 255, 255, 0.75);',
            '  border-color: rgba(255, 255, 255, 0.85);',
            '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.95), 0 1px 2px rgba(15, 20, 40, 0.06);',
            '}',
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

    // 把存储里的「内容来源」同步到设置页的高亮，以及讨论页上的那行说明
    function updateSourceSeg() {
        var cur = getDiscussSource();
        var btns = document.querySelectorAll('#mooc-auto-review-panel .mar-seg-btn');
        for (var i = 0; i < btns.length; i++) {
            var on = btns[i].getAttribute('data-source') === cur;
            if (on) btns[i].classList.add('mar-active');
            else btns[i].classList.remove('mar-active');
        }
        var now = document.getElementById('mar-source-now');
        if (now) now.textContent = sourceLabel(cur);
    }

    // 默认打开哪个选项卡，按页面内容定：看着像讨论页就给「讨论」，其余给「互评」。
    // 只在面板创建时判定一次——之后用户手动切到哪就是哪，不跟着 hash 导航乱跳。
    function pickDefaultTab() {
        if (hasDiscussion()) return 'discuss';
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
            '    <button class="mar-tab" data-tab="discuss">讨论</button>',
            '    <button class="mar-tab" data-tab="auto">自动学习</button>',
            '    <button class="mar-tab" data-tab="log">日志</button>',
            '    <button class="mar-tab" data-tab="settings">设置</button>',
            '  </div>',
            '  <div id="mar-body">',
            '    <div class="mar-pane" data-pane="review">',
            '      <button id="mar-one" class="mar-btn">一键互评（当前 1 份）</button>',
            '      <button id="mar-batch" class="mar-btn">快速互评（连续 10 份）</button>',
            '      <button id="mar-auto" class="mar-btn">全自动互评（直到完成）</button>',
            '      <button id="mar-fix" class="mar-btn">评分修复（列表检测）</button>',
            '    </div>',
            '    <div class="mar-pane" data-pane="discuss">',
            '      <button id="mar-discuss-preview" class="mar-btn">预览将回复的内容</button>',
            '      <button id="mar-discuss-reply" class="mar-btn">一键回复当前讨论</button>',
            '      <div class="mar-field">',
            '        <span class="mar-label">内容来源：<span id="mar-source-now">最新答复</span></span>',
            '        <span class="mar-hint">回复正文取自已回复区域（可在「设置」里切换来源）；同一条讨论只回复一次。</span>',
            '      </div>',
            '    </div>',
            '    <div class="mar-pane" data-pane="auto">',
            '      <button id="mar-learn-start" class="mar-btn">开始自动学习（当前章）</button>',
            '      <button id="mar-lesson-quiz" class="mar-btn">随堂测验：一键完成并提交</button>',
            '      <button id="mar-learn-probe" class="mar-btn">页面 DOM 诊断</button>',
            '      <div class="mar-field">',
            '        <span class="mar-label">随堂测验说明</span>',
            '        <span class="mar-hint">只在随堂测验（小节里那个「测试」标签）下可用：从课件接口取正确答案→逐题填涂→自动提交。读不到答案就一个选项都不点；有题目匹配不上时只填不交，留给你手动补完。</span>',
            '      </div>',
            '      <div class="mar-field">',
            '        <span class="mar-label">自动学习说明</span>',
            '        <span class="mar-hint">从当前章第一个内容开始：视频从头播放→看完进入下一个内容（测验/文档/讨论等，不是下一个视频）；文档每页 1 秒自动翻页；讨论自动回复；视频中弹出的题目自动作答（答对自动继续，答错请手动点击播放）。</span>',
            '      </div>',
            '    </div>',
            '    <div class="mar-pane" data-pane="log">',
            '      <div style="display:flex;gap:6px;margin-bottom:6px;">',
            '        <button id="mar-log-copy" class="mar-btn" style="flex:1;">复制日志</button>',
            '        <button id="mar-log-clear" class="mar-btn" style="flex:1;">清空</button>',
            '      </div>',
            '      <div class="mar-field">',
            '        <span class="mar-hint">开发者调试日志：检测到了什么、跳转决策、异常等。出现问题时切到本页复制日志发作者。</span>',
            '      </div>',
            '      <div id="mar-log-box" class="mar-log-box">（暂无日志）</div>',
            '    </div>',
            '    <div class="mar-pane" data-pane="settings">',
            '      <div class="mar-field">',
            '        <span class="mar-label">讨论内容来源</span>',
            '        <div class="mar-seg">',
            '          <button class="mar-seg-btn" data-source="latest">最新答复</button>',
            '          <button class="mar-seg-btn" data-source="liked">点赞最多</button>',
            '        </div>',
            '        <span class="mar-hint">默认「最新答复」。选「点赞最多」时，若页面没显示点赞数会自动退回最新一条。</span>',
            '      </div>',
            '      <div class="mar-field">',
            '        <span class="mar-label">视频倍速：<span id="mar-rate-now">1.0x</span></span>',
            '        <input id="mar-video-rate" type="range" min="0.5" max="3" step="0.25" value="1" style="width:100%">',
            '        <span class="mar-hint">自动学习播放视频时使用的倍速（0.5x ~ 3x）。</span>',
            '      </div>',
            '      <button id="mar-copy-unlock" class="mar-btn mar-toggle">解除复制限制：关</button>',
            '      <button id="mar-discuss-clear" class="mar-btn">清除回复记录</button>',
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
                        logDebug('err', '异常：' + (err && err.message ? err.message : err));
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

        document.getElementById('mar-discuss-preview').addEventListener('click', function () { guard(previewReply); });
        document.getElementById('mar-discuss-reply').addEventListener('click', function () { guard(replyDiscussion); });
        document.getElementById('mar-discuss-clear').addEventListener('click', function () { guard(clearDiscussHistory); });

        document.getElementById('mar-learn-start').addEventListener('click', function () { guard(learnChapter); });
        document.getElementById('mar-lesson-quiz').addEventListener('click', function () { guard(completeLessonQuiz); });
        document.getElementById('mar-learn-probe').addEventListener('click', function () { guard(probeDiscussionDom); });

        // 日志页签：复制 / 清空
        var logCopy = document.getElementById('mar-log-copy');
        var logClear = document.getElementById('mar-log-clear');
        if (logCopy) logCopy.addEventListener('click', copyDebugLogs);
        if (logClear) logClear.addEventListener('click', clearDebugLogs);
        var logTab = document.querySelector('.mar-tab[data-tab="log"]');
        if (logTab) logTab.addEventListener('click', function () { setTimeout(refreshLogBox, 30); });

        // 视频倍速滑块：拖动即落盘，视频在播的话立即生效
        var rateInput = document.getElementById('mar-video-rate');
        var rateNow = document.getElementById('mar-rate-now');
        if (rateInput && rateNow) {
            rateInput.value = loadVideoRate();
            rateNow.textContent = loadVideoRate().toFixed(2).replace(/\.?0+$/, '') + 'x';
            rateInput.addEventListener('input', function () {
                var r = parseFloat(rateInput.value) || 1;
                saveVideoRate(r);
                rateNow.textContent = r.toFixed(2).replace(/\.?0+$/, '') + 'x';
                applyVideoRate(findVideo());
                updateStatus('视频倍速已设为 ' + r + 'x');
            });
        }

        // 内容来源的分段控件：点一下就切换并落盘，下次打开面板还是这个选择
        var segBtns = panel.querySelectorAll('.mar-seg-btn');
        for (var sb = 0; sb < segBtns.length; sb++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    setDiscussSource(btn.getAttribute('data-source'));
                    updateStatus('讨论内容来源已切换为：' + sourceLabel(getDiscussSource()));
                });
            })(segBtns[sb]);
        }
        updateSourceSeg();

        document.getElementById('mar-stop').addEventListener('click', function () {
            if (!taskState.running) return;
            taskState.cancelled = true;
            // 新版路径路由跳转会整页刷新，光靠内存里的 cancelled 不够，
            // 必须同时清掉 localStorage 里的续跑状态，刷新后才会真正停下来
            learnClearState();
            setFloatVisible(false);
            updateStatus('⏹ 正在停止...');
        });

        // 初始收起停止按钮：面板刚出现时没有任务在跑
        setButtonsRunning(false);
    }

    // ===================== 随堂测验：一键完成并提交 =====================
    // 随堂测验（新版 UI 里就那个叫「测试」的 tab，组件名 LessonQuizUnit）和单元测验
    // 是两套不同的东西：
    //   随堂测验 —— 和视频/文档/讨论同一层，嵌在小节里，通常不限次数；
    //   单元测验 —— 左侧目录里单独一个节点，往往只有一次机会。
    // 所以本模块只在明确认出「随堂测验」版式时才动手，而且拿不到答案就一个选项都不点、
    // 也不提交。随堂测验可以重做，但把单元测验/考试的选项乱点一通是收不回来的。
    //
    // 答案来源：站点自己的课件接口（F12 网络面板里搜题面看到的那条 unit-page 请求就是它）
    //   /front-mooc-learn/api/learn/content/unit-page?courseKey=..&termId=..&lessonId=..&unitId=..
    // 返回的 result.quizData.questions 里，每题有 options[{id,label}] 和 correctOptionIds，
    // 把 correctOptionIds 映射回 options[].label 就是正确选项的文案，再拿文案去匹配页面上
    // 每个 label 的文字。
    //
    // 为什么以文案为主、ID 为辅：页面 DOM 里 input 的 id 常被平台加前缀（_102476797525894），
    // 而不同选项的 id 可能互为后缀——比如 102476797525894 正好是 1102476797525894 的结尾，
    // 用 indexOf/includes 比对 ID 会误命中，必须整段相等才算。
    var LESSON_QUIZ = {
        API: '/front-mooc-learn/api/learn/content/unit-page',
        // 随堂测验容器：命中任一即认为是这个版式
        scopeSelectors: [
            '[class*="LessonQuizUnit"]', '[class*="lesson-quiz"]', '[class*="lessonQuiz"]',
            '[class*="LessonQuiz"]', '[class*="quiz-unit"]', '[class*="quizUnit"]',
        ],
        // 单题容器
        blockSelectors: [
            'article', 'fieldset',
            '[class*="questionItem"]', '[class*="question-item"]', '[class*="questionBlock"]',
        ],
        MAX_BLOCKS: 60,
        SUBMIT_TEXT: /^(提交|提交答案|提交试卷|交卷)$/,
        RE_ANSWER_TEXT: /^(重新答题|重做|再做一次|重新开始)$/,
    };

    // 去标签。接口里的 title/label 都是 HTML 片段（<p>…</p>）
    function lqStripTags(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&');
    }

    // 比对用的归一化：只留汉字/字母/数字，去掉标点、空白、题号前缀。
    // 页面上题面常带「1.」「（2分）」「单选题」这类杂讯，接口标题又是 HTML，
    // 两边都不是干净字符串，不归一化基本对不上。
    function lqKey(s) {
        return lqStripTags(s).replace(/[^\u4e00-\u9fffa-zA-Z0-9]/g, '').toLowerCase();
    }

    // 从地址栏凑出接口参数。新版路径路由带 tid/unitId；
    // 缺了就从目录里指向同一课件的链接上补——参数不全接口会报课件不存在。
    function lqContext() {
        var path = location.pathname;
        var search = String(location.search || '').replace(/^\?/, '');
        var hash = location.hash || '';
        var ctx = { courseKey: null, lessonId: null, termId: null, unitId: null, entryMode: 'learn' };
        var m, sp;

        m = path.match(/\/(?:mooc|spoc)\/learn\/([^\/?#]+)/);
        if (m) ctx.courseKey = decodeURIComponent(m[1]);

        m = path.match(/\/content\/(\d+)/);
        if (m) ctx.lessonId = m[1];
        if (!ctx.lessonId) { m = hash.match(/[?&]id=(\d+)/); if (m) ctx.lessonId = m[1]; }

        function takeParams(qs) {
            if (!qs) return;
            try { sp = new URLSearchParams(qs); } catch (e) { return; }
            if (!ctx.termId) ctx.termId = sp.get('tid') || sp.get('termId');
            if (!ctx.unitId) ctx.unitId = sp.get('unitId');
            var em = sp.get('entryMode');
            if (em) ctx.entryMode = em;
        }
        takeParams(search);
        if (hash.indexOf('?') !== -1) takeParams(hash.slice(hash.indexOf('?') + 1));

        if (ctx.lessonId && (!ctx.unitId || !ctx.termId)) {
            var links = document.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {
                var href = links[i].getAttribute('href') || '';
                if (href.indexOf(String(ctx.lessonId)) === -1) continue;
                try {
                    takeParams(new URL(href, location.href).search.replace(/^\?/, ''));
                } catch (e) { /* 相对地址解析失败就跳过 */ }
                if (ctx.unitId && ctx.termId) break;
            }
        }
        return ctx;
    }

    function lqScope() {
        var hits = collectCandidates(document, LESSON_QUIZ.scopeSelectors, 20);
        var hasInput = 'input[type="radio"], input[type="checkbox"], input[type="text"], textarea';
        for (var i = 0; i < hits.length; i++) {
            if (!isVisible(hits[i])) continue;
            if (hits[i].querySelector(hasInput)) return hits[i];
        }
        return null;
    }

    // 页面上的题目区块。优先 article/fieldset；没有就从选项输入框往上爬，
    // 爬到「同一题的所有选项」那个容器为止。
    function lqBlocks(scope) {
        var root = scope || document;
        var out = [];
        var inputSel = 'input[type="radio"], input[type="checkbox"], input[type="text"], textarea';
        var shapeSel = 'input[type="radio"], input[type="checkbox"]';
        var cands = collectCandidates(root, LESSON_QUIZ.blockSelectors, LESSON_QUIZ.MAX_BLOCKS * 4);
        var i;

        for (i = 0; i < cands.length && out.length < LESSON_QUIZ.MAX_BLOCKS; i++) {
            var el = cands[i];
            if (!isVisible(el)) continue;
            if (el.closest && el.closest('#mooc-auto-review-panel, #mar-probe-overlay')) continue;
            if (!el.querySelector(inputSel)) continue;
            // 老版单元测验/作业的题块，明确不碰
            if (el.querySelector('.u-questionItem')) continue;
            if (out.indexOf(el) === -1) out.push(el);
        }
        if (out.length > 0) return out;

        var inputs = root.querySelectorAll(shapeSel);
        var seen = [];
        for (i = 0; i < inputs.length && out.length < LESSON_QUIZ.MAX_BLOCKS; i++) {
            if (!isVisible(inputs[i])) continue;
            var node = inputs[i].parentElement, hops = 0;
            while (node && hops < 8) {
                if (node.querySelectorAll(shapeSel).length >= 2) break;
                node = node.parentElement;
                hops++;
            }
            if (!node || seen.indexOf(node) !== -1) continue;
            if (node.querySelector('.u-questionItem')) continue;
            seen.push(node);
            out.push(node);
        }
        return out;
    }

    // 题干：把选项（label/input/选项容器）整个摘掉，剩下的才是题面。
    // 直接取 block.querySelector('p') 不可靠——有的版式选项本身也是 <p>。
    function lqBlockText(block) {
        var clone = block.cloneNode(true);
        var drop = clone.querySelectorAll(
            'label, input, textarea, button, select, option, ' +
            '[class*="option"], [class*="Option"], [class*="answer"], [class*="Answer"]'
        );
        for (var i = drop.length - 1; i >= 0; i--) {
            if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
        }
        return cleanText(clone.textContent || '');
    }

    function lqOptionText(el) {
        if (!el) return '';
        var clone = el.cloneNode(true);
        var ins = clone.querySelectorAll('input');
        for (var i = 0; i < ins.length; i++) {
            if (ins[i].parentNode) ins[i].parentNode.removeChild(ins[i]);
        }
        return cleanText(clone.textContent || '');
    }

    function lqOptions(block) {
        var out = [];
        var i;
        var labels = block.querySelectorAll('label');
        for (i = 0; i < labels.length; i++) {
            var lb = labels[i];
            if (!isVisible(lb)) continue;
            var input = lb.querySelector('input');
            if (!input) {
                var forId = lb.getAttribute('for');
                if (forId) {
                    try { input = block.querySelector('[id="' + CSS.escape(forId) + '"]') || document.getElementById(forId); }
                    catch (e) { input = document.getElementById(forId); }
                }
            }
            if (!input) continue;
            out.push({ el: lb, input: input, text: lqOptionText(lb) });
        }
        if (out.length === 0) {
            // 有的版式把 input 放在 label 外面
            var inputs = block.querySelectorAll('input[type="radio"], input[type="checkbox"]');
            for (i = 0; i < inputs.length; i++) {
                if (!isVisible(inputs[i]) || inputs[i].disabled) continue;
                var wrap = (inputs[i].closest && inputs[i].closest('label')) || inputs[i].parentElement;
                out.push({ el: wrap, input: inputs[i], text: lqOptionText(wrap) });
            }
        }
        return out;
    }

    // input 上所有可能是「平台选项 ID」的数字段。要求整段比对：
    // 见模块开头那条后缀陷阱，这里绝不能退化成 includes。
    function lqIdTokens(input) {
        if (!input) return [];
        var vals = [input.id, input.name, input.value];
        var attrs = ['data-option-id', 'data-optionid', 'data-id', 'data-value'];
        for (var i = 0; i < attrs.length; i++) {
            var v = input.getAttribute ? input.getAttribute(attrs[i]) : null;
            if (v) vals.push(v);
        }
        var out = [];
        for (var j = 0; j < vals.length; j++) {
            var parts = String(vals[j] === null || vals[j] === undefined ? '' : vals[j]).split(/[^0-9]+/);
            for (var k = 0; k < parts.length; k++) {
                if (parts[k] && parts[k].length >= 6 && out.indexOf(parts[k]) === -1) out.push(parts[k]);
            }
        }
        return out;
    }

    function lqParseApiQuestion(q) {
        if (!q) return null;
        var opts = q.options || q.optionList || [];
        var rawIds = q.correctOptionIds || q.correctOptionId || [];
        if (typeof rawIds === 'string') rawIds = rawIds.split(/[,\s]+/);
        var ids = [], labels = [], i, j;

        if (rawIds && rawIds.length) {
            for (i = 0; i < rawIds.length; i++) if (rawIds[i] !== null && rawIds[i] !== undefined && rawIds[i] !== '') ids.push(String(rawIds[i]));
        }
        for (i = 0; i < ids.length; i++) {
            for (j = 0; j < opts.length; j++) {
                if (String(opts[j].id) === ids[i]) {
                    labels.push(lqStripTags(opts[j].label || opts[j].content || ''));
                    break;
                }
            }
        }
        // 有的接口不给 correctOptionIds，只在选项上打 answer 标记
        if (labels.length === 0) {
            for (i = 0; i < opts.length; i++) {
                var o = opts[i];
                if (o && (o.answer === true || o.isAnswer === true || o.correct === true)) {
                    labels.push(lqStripTags(o.label || o.content || ''));
                    if (o.id) ids.push(String(o.id));
                }
            }
        }
        // 填空题：correctAnswer 形如「答案#解析」，多空时用 # 分段
        var blanks = [];
        if (q.correctAnswer) {
            var segs = lqStripTags(q.correctAnswer).split('#');
            for (i = 0; i < segs.length; i++) {
                var seg = cleanText(segs[i]);
                if (seg) blanks.push(seg);
            }
        }
        return {
            type: q.type,
            title: lqStripTags(q.title || q.plainTextTitle || ''),
            ids: ids,
            labels: labels,
            blanks: blanks,
        };
    }

    async function lqFetchQuestions(ctx) {
        if (!ctx || !ctx.courseKey || !ctx.lessonId) {
            return { ok: false, error: '地址栏里解析不到 courseKey / lessonId' };
        }
        var qs = [
            'courseKey=' + encodeURIComponent(ctx.courseKey),
            'lessonId=' + encodeURIComponent(ctx.lessonId),
            'entryMode=' + encodeURIComponent(ctx.entryMode || 'learn'),
        ];
        if (ctx.termId) qs.push('termId=' + encodeURIComponent(ctx.termId));
        if (ctx.unitId) qs.push('unitId=' + encodeURIComponent(ctx.unitId));
        var url = LESSON_QUIZ.API + '?' + qs.join('&');
        logDebug('quiz', '请求答案接口：' + url);

        var json = null;
        try {
            var res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'application/json' } });
            if (!res.ok) return { ok: false, error: '接口 HTTP ' + res.status };
            json = await res.json();
        } catch (e) {
            return { ok: false, error: '接口请求失败：' + (e && e.message ? e.message : e) };
        }

        var quiz = json && json.result && json.result.quizData;
        var list = quiz && (quiz.questions || quiz.questionList || quiz.questionVoList);
        if (!list || !list.length) {
            logDebug('quiz', '接口没给 quizData.questions；result 的键＝'
                + (json && json.result ? Object.keys(json.result).join(',') : '（无 result）'));
            return { ok: false, error: '接口里没有 quizData.questions（当前内容可能不是随堂测验）' };
        }
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var q = lqParseApiQuestion(list[i]);
            if (q) out.push(q);
        }
        if (out.length === 0) return { ok: false, error: '接口返回了题目但没解析出答案' };
        return { ok: true, questions: out };
    }

    // 页面上这一题的题面 → 接口里的哪一题。优先精确相等，其次互相包含
    // （页面多题号/分值、或者文本被截断都会导致两边长度不同）。
    function lqMatchQuestion(questions, text, used) {
        var key = lqKey(text);
        if (!key) return null;
        var best = null, bestScore = 0;
        for (var i = 0; i < questions.length; i++) {
            var q = questions[i];
            if (used.indexOf(q) !== -1) continue;
            var k = lqKey(q.title);
            if (!k) continue;
            var score = 0;
            if (k === key) score = 100000 + k.length;
            else if (key.indexOf(k) !== -1) score = 50000 + k.length;
            else if (k.indexOf(key) !== -1) score = 40000 + key.length;
            else if (k.length >= 10 || key.length >= 10) {
                // 两边都有增删时用五字滑窗覆盖率兜底，命中率够高才认
                var shorter = k.length <= key.length ? k : key;
                var longer = k.length <= key.length ? key : k;
                var hit = 0, total = 0;
                for (var s = 0; s + 5 <= shorter.length; s += 5) {
                    total++;
                    if (longer.indexOf(shorter.substr(s, 5)) !== -1) hit++;
                }
                if (total > 0 && hit / total >= 0.85) score = 10000 + shorter.length;
            }
            if (score > bestScore) { bestScore = score; best = q; }
        }
        return best;
    }

    // 该题应该勾哪几个选项（返回选项下标）。先用平台 ID 整段比对，
    // 认不出来再用正确选项的文案匹配。
    function lqCorrectIndexes(block, q) {
        var opts = lqOptions(block);
        var picked = [];
        var i, j, k;

        if (q.ids && q.ids.length) {
            for (i = 0; i < opts.length; i++) {
                var tokens = lqIdTokens(opts[i].input);
                for (j = 0; j < q.ids.length; j++) {
                    if (tokens.indexOf(q.ids[j]) !== -1) { picked.push(i); break; }
                }
            }
        }

        if (picked.length === 0 && q.labels && q.labels.length) {
            for (k = 0; k < q.labels.length; k++) {
                var target = lqKey(q.labels[k]);
                if (!target) continue;
                var best = -1, bestScore = 0;
                for (i = 0; i < opts.length; i++) {
                    if (picked.indexOf(i) !== -1) continue;
                    var t = lqKey(opts[i].text);
                    if (!t) continue;
                    var score = 0;
                    if (t === target) score = 1000 + t.length;
                    else if (t.indexOf(target) !== -1) score = 500 + target.length;
                    else if (target.indexOf(t) !== -1 && t.length >= 2) score = 300 + t.length;
                    if (score > bestScore) { bestScore = score; best = i; }
                }
                if (best !== -1) picked.push(best);
            }
        }

        picked.sort(function (a, b) { return a - b; });
        return picked;
    }

    async function lqApplyAnswer(block, q) {
        var i;

        // 填空题
        if (q.type == 3 || /COMPLETION/i.test(String(q.type))) {
            var fields = [];
            var raw = block.querySelectorAll('textarea, input[type="text"], input:not([type])');
            for (i = 0; i < raw.length; i++) {
                if (isVisible(raw[i]) && !raw[i].disabled && !raw[i].readOnly) fields.push(raw[i]);
            }
            if (fields.length === 0 || q.blanks.length === 0) return { ok: false, reason: '填空无输入框/无答案' };
            // 空的个数对得上才逐空填，否则只填第一空（多出来的多半是解析/说明文字）
            var use = (fields.length === q.blanks.length) ? q.blanks : [q.blanks[0]];
            for (i = 0; i < fields.length && i < use.length; i++) {
                setNativeValue(fields[i], use[i]);
                await sleep(150);
            }
            var allOk = (fields.length <= use.length);
            for (i = 0; i < fields.length && i < use.length; i++) {
                if (cleanText(fields[i].value) !== cleanText(use[i])) allOk = false;
            }
            return { ok: allOk, reason: '填空' };
        }

        var idxs = lqCorrectIndexes(block, q);
        if (idxs.length === 0) return { ok: false, reason: '未匹配到选项' };

        for (i = 0; i < idxs.length; i++) {
            var opts = lqOptions(block);   // 每次重新查：点一下平台就会重渲染
            var opt = opts[idxs[i]];
            if (!opt) continue;
            if (!opt.input.checked) {
                try { opt.input.click(); } catch (e) { realClick(opt.input); }
                if (!opt.input.checked) selectRadio(opt.input);
                await sleep(CONFIG.DELAY_AFTER_CLICK);
            }
        }

        var after = lqOptions(block);
        var hit = 0;
        for (i = 0; i < idxs.length; i++) {
            if (after[idxs[i]] && after[idxs[i]].input.checked) hit++;
        }
        return { ok: hit === idxs.length, reason: '选项 ' + hit + '/' + idxs.length };
    }

    function lqFindSubmit(scope) {
        var roots = scope ? [scope, document] : [document];
        for (var r = 0; r < roots.length; r++) {
            var els = roots[r].querySelectorAll('button, [role="button"], input[type="submit"], a');
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (!isVisible(el) || el.disabled) continue;
                if (el.closest && el.closest('#mooc-auto-review-panel, #mar-probe-overlay, #mar-float-next')) continue;
                var t = cleanText(el.textContent || el.value || '');
                if (LESSON_QUIZ.SUBMIT_TEXT.test(t)) return el;
            }
        }
        return null;
    }

    function lqFindReAnswer() {
        var els = document.querySelectorAll('button, a, [role="button"]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el) || el.disabled) continue;
            if (LESSON_QUIZ.RE_ANSWER_TEXT.test(cleanText(el.textContent || ''))) return el;
        }
        return null;
    }

    // 提交后可能弹「确定要提交吗」。只点确定/确认类按钮，取消/关闭一律不碰。
    function lqConfirmButton() {
        var dlgs = collectCandidates(document, [
            '[class*="dialog"]', '[class*="Dialog"]', '[class*="modal"]', '[class*="Modal"]',
            '[class*="popup"]', '[class*="layer"]',
        ], 30);
        for (var d = 0; d < dlgs.length; d++) {
            var dlg = dlgs[d];
            if (!isVisible(dlg)) continue;
            if (dlg.clientWidth < 160 || dlg.clientHeight < 80) continue;
            if (dlg.closest && dlg.closest('#mooc-auto-review-panel, #mar-probe-overlay')) continue;
            var btns = dlg.querySelectorAll('button, [role="button"], a, input[type="submit"]');
            for (var b = 0; b < btns.length; b++) {
                if (!isVisible(btns[b]) || btns[b].disabled) continue;
                var t = cleanText(btns[b].textContent || btns[b].value || '');
                if (/^(确定|确认|确认提交|确定提交|继续|是的|好的|提交)$/.test(t)) return btns[b];
            }
        }
        return null;
    }

    // 提交后弹窗里的成绩文案（解析不出来就返回空，不影响流程）
    function lqReadResult() {
        var els = collectCandidates(document, [
            '[class*="dialog"]', '[class*="Dialog"]', '[class*="modal"]', '[class*="Modal"]',
            '[class*="result"]', '[class*="Result"]',
        ], 20);
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el) || el.clientWidth < 160) continue;
            if (el.closest && el.closest('#mooc-auto-review-panel, #mar-probe-overlay')) continue;
            var t = cleanText(el.textContent || '');
            if (!t || t.length > 300) continue;
            if (/正确率|答对|答错|得分|本次得分|共\s*\d+\s*题/.test(t)) return t.slice(0, 120);
        }
        return '';
    }

    async function completeLessonQuiz() {
        if (PAGE_CONFIG.examUrl.test(location.href)) {
            updateStatus('⚠️ 这是考试页，本功能不处理（考试通常只有一次机会，请手动作答）');
            return;
        }

        var scope = lqScope();
        var blocks = lqBlocks(scope);
        if (blocks.length === 0) {
            updateStatus('⚠️ 没检测到随堂测验题目：请先进入小节里的「测试」标签再点我');
            return;
        }
        logDebug('quiz', '检测到随堂测验：容器' + (scope ? '命中' : '未命中（整页兜底）') + '，题块 ' + blocks.length + ' 个');

        // 之前提交过、现在停在结果页：先点「重新答题」回到作答态
        var re = lqFindReAnswer();
        if (re) {
            updateStatus('↻ 检测到已答过，先点「重新答题」...');
            realClick(re);
            await sleep(1500);
            scope = lqScope();
            blocks = lqBlocks(scope);
            if (blocks.length === 0) {
                updateStatus('❌ 重新答题后没找到题目区块，已停止（未提交）');
                return;
            }
        }

        updateStatus('🔎 正在从课件接口读取本次随堂测验的答案...');
        var res = await lqFetchQuestions(lqContext());
        if (!res.ok) {
            updateStatus('❌ 读不到正确答案：' + res.error + '（一个选项都没点，也没提交）');
            return;
        }
        logDebug('quiz', '接口返回 ' + res.questions.length + ' 道题，页面题块 ' + blocks.length + ' 个');

        var used = [], filled = 0, missing = [];
        for (var i = 0; i < blocks.length; i++) {
            if (taskState.cancelled) throw makeCancelError();
            var block = blocks[i];
            var text = lqBlockText(block);
            var q = lqMatchQuestion(res.questions, text, used);
            if (!q) {
                missing.push(text.slice(0, 24) || ('第 ' + (i + 1) + ' 题'));
                logDebug('quiz', '第 ' + (i + 1) + ' 题没匹配上答案：' + text.slice(0, 40));
                continue;
            }
            used.push(q);
            var r = await lqApplyAnswer(block, q);
            if (r.ok) filled++;
            else {
                missing.push(text.slice(0, 24) || ('第 ' + (i + 1) + ' 题'));
                logDebug('quiz', '第 ' + (i + 1) + ' 题作答不完整：' + r.reason);
            }
            updateStatus('📝 作答中 ' + (i + 1) + '/' + blocks.length + ' 题（已填 ' + filled + '）...');
            await sleep(250);
        }

        if (filled === 0) {
            updateStatus('❌ 一题都没能作答（答案和页面题目对不上），已停止，未提交');
            return;
        }
        // 少答一题就提交等于交白卷。宁可留几道让人补，也不替他赌。
        if (missing.length > 0 || res.questions.length > blocks.length) {
            var why = missing.length > 0
                ? ('有 ' + missing.length + ' 题没匹配上答案（' + missing.join(' / ') + '）')
                : ('接口有 ' + res.questions.length + ' 题、页面只渲染了 ' + blocks.length + ' 题，可能分页显示');
            updateStatus('⚠️ 已填 ' + filled + ' 题，但' + why + '；请手动补完再点提交（为免交白卷，未自动提交）');
            return;
        }

        var submit = lqFindSubmit(scope);
        if (!submit) {
            updateStatus('⚠️ ' + filled + ' 题已全部作答，但没找到「提交」按钮，请手动提交');
            return;
        }
        updateStatus('🚀 ' + filled + ' 题已全部作答，正在提交...');
        realClick(submit);
        await sleep(1200);
        for (var c = 0; c < 3; c++) {
            var okBtn = lqConfirmButton();
            if (!okBtn) break;
            logDebug('quiz', '提交确认弹窗，点击「' + cleanText(okBtn.textContent) + '」');
            realClick(okBtn);
            await sleep(1500);
        }
        await sleep(800);
        var result = lqReadResult();
        if (result) logDebug('quiz', '提交结果：' + result);
        updateStatus('✅ 随堂测验已提交（' + filled + ' 题）' + (result ? '：' + result : ''));
    }

    // ===================== 自动学习（新版学习页） =====================
    // 同时支持新版学习页两种形态：
    //   旧版 hash 路由：#/learn/content?type=detail&id=xxx
    //   新版路径路由：/mooc/learn/{课程}/content/{内容ID}?tid=...&chapterId=...
    // 整章自动学习：
    //   视频：从头播放；看完后按目录进入下一个内容（测验/文档/讨论等），
    //         而不是跳到下一个视频；
    //   文档：自动翻页，每页停留 1 秒（含新版 mooc-docs-reader 缩略图阅读器）；
    //   讨论：自动回复（复用课堂讨论逻辑）；
    //   视频中弹出的题目：自动作答（正确与否不保证）——
    //         答对平台放行、视频自动继续；答错则等待用户手动点击播放后继续；
    //   独立测验：只停留片刻不自动作答（避免消耗答题次数）。
    // 目录解析失败时退化为按 id±1 相邻导航，并用章节标题判断边界。
    // 新版路径路由跳转 = 整页刷新，靠 localStorage 续跑状态跨页续跑。

    // 页面里是否有“可见”的题目块（随堂测验/单元测验/考试页通用）
    function hasVisibleQuestionBlocks() {
        var els = document.querySelectorAll(
            '.u-questionItem, .m-choiceQuestion, .m-subjectiveQuestion, .m-fillblankQuestion, .j-questionItem, ' +
            '[class*="questionItem"], [class*="question-item"], [class*="choiceQuestion"], [class*="fillblankQuestion"], ' +
            '[class*="fillblank"], [class*="judgeQuestion"], [class*="objectiveQuestion"], [class*="testItem"]'
        );
        for (var i = 0; i < els.length; i++) {
            if (isVisible(els[i])) return true;
        }
        return false;
    }

    // 从地址栏解析当前内容 ID：
    //   新版路径路由：/mooc/learn/{课程}/content/{内容ID}?tid=...（Hash 为空）
    //   旧版 hash 路由：#/learn/content?type=detail&id=123
    function learnCurrentContentId() {
        var m = location.pathname.match(/\/content\/(\d+)/);
        if (m) return parseInt(m[1], 10);
        m = location.hash.match(/id=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // 当前课程路径前缀，例如 /mooc/learn/HPU-1474216172
    // 用来过滤页面里其他课程/广告链接，保证只收集本课程的内容链接
    function learnCoursePrefix() {
        var m = location.pathname.match(/^(\/mooc\/learn\/[^/]+)/);
        return m ? m[1] : null;
    }

    // 收集章节目录里的内容链接（含 data-id 的节点），按页面顺序返回 [{id, el, href}]
    // 优先严格模式：只收能归属到某个“章”的链接（chapterTitleOfLink 非空），
    // 避免页面上的课程卡片/广告链接污染本章内容列表。
    // 若严格模式一个都收不到（新版侧栏可能没有可解析的章标题节点），
    // 退回宽松模式：收本课程路径下所有 /content/ 链接。
    function learnContentLinks() {
        var strict = collectCatalogLinks(true);
        if (strict.length > 0) return strict;
        var loose = collectCatalogLinks(false);
        return loose;
    }

    function collectCatalogLinks(requireChapter) {
        var out = [], seen = {};
        var coursePrefix = learnCoursePrefix();
        var sels = [
            '[class*="catalog"] a, [class*="chapter"] a, [class*="menu"] a, [class*="lesson"] a, [class*="section"] a, [class*="unit"] a, [class*="node"] a, [class*="learnItem"] a, [class*="learn-item"] a',
            '[class*="catalog"] [data-id], [class*="chapter"] [data-id], [class*="menu"] [data-id], [class*="lesson"] [data-id], [class*="section"] [data-id], [class*="node"] [data-id]',
            '[class*="catalog"] [data-content-id], [class*="chapter"] [data-content-id], [class*="lesson"] [data-content-id]',
            // 新版 UI（mooc- 前缀侧栏）
            '[class*="mooc-catalog"] a, [class*="mooc-lesson"] a, [class*="mooc-chapter"] a, [class*="mooc-sidebar"] a, [class*="mooc-menu"] a, [class*="mooc-nav"] a',
            '[class*="mooc-catalog"] [data-content-id], [class*="mooc-lesson"] [data-content-id]',
            // 新版 UI（learn- 前缀侧栏，如 learn-navigation-link）
            '[class*="learn-navigation"] a, [class*="learn-nav"] a, [class*="learn-catalog"] a, [class*="learn-lesson"] a, [class*="learn-chapter"] a, [class*="learn-section"] a, [class*="learn-unit"] a, [class*="learn-list"] a, [class*="learn-menu"] a',
            '[class*="learn-navigation"] [data-content-id], [class*="learn-list"] [data-content-id], [class*="learn-lesson"] [data-content-id]',
            // 旧版 hash 路由
            'a[href*="#/learn/content"]',
            'a[href*="#/learn/forum"]',
        ];
        if (!requireChapter) {
            // 宽松模式：本课程路径下所有指向 /content/ 的链接，以及 learn-navigation 锚点
            sels.push('a[href*="/content/"]');
            sels.push('a[class*="learn-navigation"], a[class*="learn-nav"], a[href*="/mooc/learn/"]');
        }
        for (var s = 0; s < sels.length; s++) {
            var els;
            try { els = document.querySelectorAll(sels[s]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var srcEl = els[i];
                var a = (srcEl.tagName === 'A') ? srcEl : srcEl.querySelector('a[href*="id="], a[href*="/content/"]');
                // 跳过“上一个/下一个/返回”这类导航按钮
                if (a && /上一个|下一个|上一节|下一节|上一讲|下一讲|上一章|下一章|返回|首页/.test(cleanText((a.textContent || '').slice(0, 6)))) continue;
                if (a && coursePrefix) {
                    var ah = a.getAttribute('href') || '';
                    // 宽松模式下只收本课程的链接；目录容器里的链接不强制（容器本身已限定范围）
                    if (!requireChapter && ah.indexOf(coursePrefix) !== 0 && ah.indexOf('#') !== 0) continue;
                }
                var id = linkIdOf(a || srcEl);
                if (id === null || seen[id]) continue;
                // 严格模式必须能归属到章；宽松模式不要求
                if (requireChapter && !chapterTitleOfLink(a || srcEl)) continue;
                seen[id] = true;
                out.push({ id: id, el: a || srcEl, href: a ? (a.getAttribute('href') || '') : '' });
            }
        }
        return out;
    }

    // 从链接（或带 data 属性的节点）里解析内容 ID，兼容新旧两种 URL 形态
    function linkIdOf(node) {
        if (!node) return null;
        var href = (node.getAttribute && node.getAttribute('href')) || '';
        var m = href.match(/\/content\/(\d+)/) || href.match(/id=(\d+)/);
        if (m) return parseInt(m[1], 10);
        var di = (node.getAttribute && (node.getAttribute('data-content-id') || node.getAttribute('data-id'))) || '';
        if (di && /^\d+$/.test(di)) return parseInt(di, 10);
        return null;
    }

    // 形如「1 总论」「第1章 xxx」「第一章」「第一单元」的才是章标题。
    // 注意排除节标题（1-1 xxx）和测验条目（单元测验/随堂测验）。
    function looksLikeChapterHeading(t) {
        if (!t || t.length < 2 || t.length > 30) return false;
        if (/章|讲|篇|专题|Module|Chapter|Part/i.test(t)) return true;
        if (/周/.test(t) && /第\s*[一二三四五六七八九十\d]+\s*周/.test(t)) return true;
        if (/单元(?!测验|测试|作业|检测|练习)/.test(t)) return true;
        if (/^\d{1,2}\s*[^\d.、．\-－]/.test(t)) return true; // “1 总论”“2 会计科目”
        return false;
    }

    // 某个内容链接所属“章”的标题（从它的祖先链上找章标题节点）
    function chapterTitleOfLink(link) {
        var node = link && link.parentElement;
        var depth = 0;
        while (node && depth < 10) {
            var heads = node.querySelectorAll(
                ':scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, ' +
                ':scope > [class*="chapter"], :scope > [class*="catalog-title"], :scope > [class*="catalogTitle"], ' +
                ':scope > [class*="unit-title"], :scope > [class*="unitTitle"]'
            );
            for (var i = 0; i < heads.length; i++) {
                var t = cleanText(heads[i].textContent);
                if (looksLikeChapterHeading(t)) return t;
            }
            node = node.parentElement;
            depth++;
        }
        return null;
    }

    // 当前页面的章节标题（标题栏/面包屑 → 目录兜底）
    function learnChapterTitleText() {
        var cands = [
            '.titleBar', '[class*="titleBar"]', '[class*="crumb"]', '[class*="breadcrumb"]',
            '[class*="chapterTitle"]', '[class*="chapter-title"]', '[class*="learnTitle"]',
            '[class*="content-title"]', '.m-crumb',
            // 新版 UI（learn- 前缀）
            '[class*="learn-title"]', '[class*="learn-chapter"]', '[class*="learn-catalog"]',
            '[class*="learn-lesson-title"]', '[class*="learn-header-title"]', '[class*="learn-unit"]',
            '[class*="learn-section-title"]', '[class*="learn-content-title"]',
        ];
        for (var c = 0; c < cands.length; c++) {
            var els;
            try { els = document.querySelectorAll(cands[c]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var t = cleanText(els[i].textContent);
                if (!t || t.length > 80) continue;
                var segs = t.split(/[>›»·|—–/]/);
                for (var k = 0; k < segs.length; k++) {
                    var seg = cleanText(segs[k]);
                    if (looksLikeChapterHeading(seg)) return seg;
                }
                // 宽松兜底：取第一段
                var first = cleanText(segs[0]);
                if (first && first.length >= 2 && first.length <= 30 && !/^\d+$/.test(first)) return first;
            }
        }
        var heads = document.querySelectorAll('[class*="catalog"] h3, [class*="catalog"] h4, [class*="chapter"] h3, [class*="chapter"] h4, [class*="catalog"] [class*="chapter"], [class*="catalog"] [class*="catalog-title"], [class*="catalog"] [class*="catalogTitle"], [class*="learn-navigation"] h3, [class*="learn-navigation"] h4, [class*="learn-list"] [class*="title"], [class*="learn-nav"] [class*="title"]');
        for (i = 0; i < heads.length; i++) {
            var t2 = cleanText(heads[i].textContent);
            if (looksLikeChapterHeading(t2)) return t2;
        }
        return null;
    }

    // 可见的 video 元素
    function findVideo() {
        var v = document.querySelector('video');
        return v && isVisible(v) ? v : null;
    }

    // 播放器上的“播放/开始”按钮（autoplay 被拦时兜底用真实点击）
    function findPlayButtons() {
        var out = [], els = document.querySelectorAll('button, a, [role="button"], span, div');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el)) continue;
            var cls = String(el.className || '');
            var label = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '';
            if (!/\b(play|start)\b/i.test(cls) && !/play|start/i.test(label) && !/播放|开始/.test(cleanText((el.textContent || '').slice(0, 12)))) continue;
            if (el.clientWidth > 400 || el.clientHeight > 400) continue;
            out.push(el);
        }
        return out;
    }

    async function playVideo(video) {
        if (!video) return;
        applyVideoRate(video);
        var p = null;
        try { p = video.play(); } catch (e) { p = null; }
        if (p && p.catch) p.catch(function () {});
        // 等 play() 生效：视频仍在暂停就继续等一小段
        var t0 = Date.now();
        while (Date.now() - t0 < 2500 && video.paused) { await sleep(200); }
        if (!video.paused) return;
        // autoplay 被拦时兜底：真实点击播放器上的播放/开始按钮
        var btns = findPlayButtons();
        var clicked = false;
        for (var i = 0; i < btns.length; i++) { realClick(btns[i]); clicked = true; }
        if (clicked) await sleep(700);
    }

    // —— 视频倍速（设置页可调，0.5x ~ 3x，落盘 localStorage）——
    function loadVideoRate() {
        try {
            var r = parseFloat(localStorage.getItem('mar.video.rate'));
            if (r >= 0.5 && r <= 3) return r;
        } catch (e) {}
        return 1;
    }
    function saveVideoRate(r) {
        try { localStorage.setItem('mar.video.rate', String(r)); } catch (e) {}
    }
    // 把倍速应用到视频上（部分播放器切清晰度/拖动进度后会重置倍速，需要持续应用）
    function applyVideoRate(video) {
        var r = loadVideoRate();
        try { if (video && Math.abs(video.playbackRate - r) > 0.01) video.playbackRate = r; } catch (e) {}
    }

    // 视频中弹出的题目浮层。只在有视频时探测；强特征（题干文字）出现时
    // 即使视频还在播也认，避免漏掉“先弹题后暂停”的情况。
    function findQuizPopup() {
        var video = findVideo();
        if (!video) return null;
        var sels = [
            '[class*="dialog"]', '[class*="modal"]', '[class*="popup"]', '[class*="layer"]', '[class*="overlay"]',
            '[class*="question"]', '[class*="quiz"]', '[class*="Quiz"]', '[class*="testQuestion"]',
            '[class*="interaction"]', '[class*="ask"]', '[class*="topic"]',
        ];
        for (var s = 0; s < sels.length; s++) {
            var els;
            try { els = document.querySelectorAll(sels[s]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (!isVisible(el)) continue;
                if (el.clientWidth < 220 || el.clientHeight < 120) continue;
                if (el.closest && el.closest('[class*="catalog"], [class*="sidebar"], [class*="menu"]')) continue;
                var txt = cleanText(el.textContent).slice(0, 400);
                if (!txt) continue;
                var strong = /请选择|请回答|请作答|单选题|多选题|判断题|填空题/.test(txt);
                var markers = strong || /本题|选项|[A-H]\s*[\.、．）)]/.test(txt);
                if (!markers) continue;
                if (!video.paused && !strong) continue;
                var hasOpt = false, hasSub = false, o, b;
                var opts = el.querySelectorAll('input[type="radio"], input[type="checkbox"], label, [class*="option"], [class*="choice"], [class*="answer"]');
                for (o = 0; o < opts.length; o++) { if (isVisible(opts[o])) { hasOpt = true; break; } }
                var subs = el.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]');
                for (b = 0; b < subs.length; b++) { if (isVisible(subs[b])) { hasSub = true; break; } }
                if (!hasOpt && !hasSub) continue;
                return el;
            }
        }
        return null;
    }

    // 作答弹题：选第一个选项 → 点提交/继续。对错不保证。
    async function answerQuizPopup(popup) {
        var i, clickedOpt = false;
        var radios = popup.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        for (i = 0; i < radios.length; i++) {
            if (isVisible(radios[i]) && !radios[i].disabled) { realClick(radios[i]); clickedOpt = true; break; }
        }
        if (!clickedOpt) {
            var opts = popup.querySelectorAll('label, li, [class*="option"], [class*="choice"], [class*="answer"], [class*="selectItem"]');
            for (i = 0; i < opts.length; i++) {
                var el = opts[i];
                if (!isVisible(el)) continue;
                var t = cleanText(el.textContent);
                if (!t || t.length > 120) continue;
                if (/^(确定|提交|完成|继续|关闭|下一题|保存|我知道了|重试)$/.test(t)) continue;
                realClick(el); clickedOpt = true; break;
            }
        }
        if (!clickedOpt) updateStatus('⚠️ 题目弹窗里没找到选项，先尝试直接提交');
        await sleep(500);
        var btns = popup.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"], div[role="button"], span[role="button"]');
        var SUBMIT = /^(提交|确定|完成|继续|下一题|保存|提交答案|确认|知道了)$/;
        for (i = 0; i < btns.length; i++) {
            var el2 = btns[i];
            if (!isVisible(el2) || el2.disabled) continue;
            var tt = cleanText(el2.textContent || el2.value || '').slice(0, 6);
            if (SUBMIT.test(tt)) { realClick(el2); return true; }
        }
        return clickedOpt;
    }

    async function waitForVideo() {
        var t0 = Date.now();
        while (Date.now() - t0 < 20000) {
            if (taskState.cancelled) throw makeCancelError();
            var v = findVideo();
            if (v) return v;
            await sleep(500);
        }
        return null;
    }

    // 视频内容：从头播放 → 处理弹题 → 看完返回 true
    async function learnVideoItem() {
        var video = await waitForVideo();
        if (!video) { logDebug('video', '⚠️ 未检测到播放器，按其它内容处理'); updateStatus('⚠️ 未检测到播放器，按其它内容处理'); return true; }
        // 监听 ended 事件：视频一播完立刻触发跳转（比轮询更快更可靠）
        if (!video.__marEndedHook) {
            video.__marEndedHook = true;
            video.addEventListener('ended', function () {
                try { video.__marEndedFlag = true; } catch (e) {}
            });
        }
        try { if (video.currentTime > 0) video.currentTime = 0; } catch (e) {}
        logDebug('video', '从头播放：时长=' + (video.duration ? video.duration.toFixed(1) : '?') + 's，倍速=' + loadVideoRate() + 'x');
        updateStatus('▶ 从头播放视频，看完自动进入下一个内容...');
        await playVideo(video);

        var manualResume = false;
        var lastAnswerAt = 0;
        var lastRetry = 0;
        while (!taskState.cancelled) {
            video = findVideo() || video;
            applyVideoRate(video); // 持续应用倍速（切清晰度/拖动进度后平台可能重置）

            // 0) 用户点了【下一节】→ 跳过当前视频
            if (manualWaitFlag) { logDebug('video', '用户点击【下一节】，跳过当前视频'); updateStatus('⏭ 用户点击【下一节】，跳过当前视频'); return true; }

            // 1) 视频中弹出题目 → 作答
            var popup = findQuizPopup();
            if (popup && Date.now() - lastAnswerAt > 2500) {
                lastAnswerAt = Date.now();
                updateStatus('📝 视频中弹出题目，自动作答（不保证对错，只为让视频继续）...');
                logDebug('quiz', '视频中弹出题目，自动作答...');
                await answerQuizPopup(popup);
                var t0 = Date.now(), resumed = false;
                while (Date.now() - t0 < CONFIG.LEARN_QUIZ_RESUME_WAIT) {
                    await sleep(CONFIG.LEARN_IDLE_POLL);
                    var vv = findVideo();
                    if (vv && !vv.paused && vv.currentTime > 0) { resumed = true; break; }
                }
                if (resumed) {
                    logDebug('quiz', '✅ 答对，平台放行，视频自动继续');
                    updateStatus('✅ 题目已答，平台放行，视频自动继续播放');
                } else {
                    logDebug('quiz', '⚠️ 可能答错，视频停止 —— 请手动点播放，脚本持续监控');
                    updateStatus('⚠️ 答案可能不对，视频已停止 —— 请手动点击播放按钮继续，脚本会继续监控');
                    manualResume = true;
                    var v = findVideo();
                    if (v) {
                        await new Promise(function (resolve) {
                            var doneFlag = false;
                            function fin() { if (doneFlag) return; doneFlag = true; clearInterval(poller); resolve(); }
                            function check() {
                                if (taskState.cancelled || manualWaitFlag) { fin(); return; }
                                var c = findVideo();
                                if (c && !c.paused) fin();
                            }
                            var poller = setInterval(check, 600);
                            setTimeout(fin, 10 * 60 * 1000);
                            if (v.addEventListener) v.addEventListener('play', fin, { once: true });
                        });
                    }
                    manualResume = false;
                    logDebug('video', '已检测到手动播放，继续监控');
                    updateStatus('▶ 已检测到手动播放，继续监控视频...');
                }
                continue;
            }

            // 2) 看完 → 进入下一个内容（ended 事件触发或时长到边）
            if (video.__marEndedFlag || video.ended || (video.duration > 0 && video.currentTime >= video.duration - CONFIG.LEARN_VIDEO_END_MARGIN)) {
                logDebug('video', '🎬 播放完毕（currentTime=' + (video.currentTime || 0).toFixed(1) + '/duration=' + (video.duration || 0).toFixed(1) + '）');
                updateStatus('🎬 视频播放完毕');
                return true;
            }

            // 3) 意外暂停（非弹题、非手动等待）→ 尝试恢复
            if (video.paused && !manualResume && Date.now() - lastAnswerAt > 2500 && Date.now() - lastRetry > 2500) {
                lastRetry = Date.now();
                await playVideo(video);
            }
            await sleep(CONFIG.LEARN_IDLE_POLL);
        }
        return false;
    }

    // 文档查看器（新版课件/PDF/PPT；含新版 mooc-docs-reader 阅读器）
    function findDocViewer() {
        var sels = [
            '[class*="mooc-docs-reader"]', '[class*="docs-reader"]', '[class*="mooc-doc"]',
            '[class*="doc-viewer"]', '[class*="docViewer"]', '[class*="document-viewer"]',
            '[class*="pptViewer"]', '[class*="ppt-viewer"]', '[class*="pdfViewer"]', '[class*="pdf-viewer"]',
            '[class*="slideViewer"]', '[class*="slide-viewer"]', '[class*="coursewareViewer"]',
            '[class*="course-doc"]', '[class*="courseDoc"]', '[class*="docContent"]', '[class*="doc-content"]',
            '[class*="docPage"]', '[class*="doc-page"]', '[class*="slidePage"]', '[class*="slide-page"]',
            '[class*="attachmentPage"]', '[class*="attachment-page"]',
        ];
        for (var s = 0; s < sels.length; s++) {
            var els;
            try { els = document.querySelectorAll(sels[s]); } catch (e) { continue; }
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (!isVisible(el)) continue;
                if (el.clientHeight < 120 || el.clientWidth < 200) continue;
                if (el.closest && el.closest('[class*="catalog"], [class*="sidebar"], [class*="menu"], [class*="nav"]')) continue;
                return el;
            }
        }
        // 兜底：主内容区里一张可见的大图（文档页常为整页图片）
        var imgs = document.querySelectorAll('img');
        for (i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (!isVisible(im)) continue;
            if (im.clientWidth < 200 || im.clientHeight < 150) continue;
            if (im.closest && im.closest('[class*="catalog"], [class*="avatar"], [class*="header"], [class*="footer"], [class*="qr"]')) continue;
            return im.closest('div, section') || im;
        }
        return null;
    }

    // 文档的“下一页”按钮（含新版阅读器：点当前激活页缩略图的后一张）
    function findDocNextBtn() {
        var scope = findDocViewer() || document;
        // 新版 mooc-docs-reader：缩略图按钮 1..N，is-active 是当前页
        var thumbs = scope.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            for (var t = 0; t < thumbs.length - 1; t++) {
                if (thumbs[t].classList.contains('is-active')) return thumbs[t + 1];
            }
            return null; // 已在最后一页
        }
        var els = scope.querySelectorAll(
            'button, a, span, [role="button"], input[type="button"], input[type="submit"], ' +
            '[class*="next"], [class*="Next"], [class*="turn"], [class*="arrow"], [class*="Arrow"]'
        );
        var NEXT_TEXT = /^(下一页|下一张|后一页|下一|下页|下一个|»|›|>|＞)$/;
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (!isVisible(el) || el.disabled) continue;
            var label = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('title') || '') : '';
            var txt = cleanText((el.textContent || '').slice(0, 8));
            if (NEXT_TEXT.test(txt) || /下一页|下一张/.test(label)) return el;
            var cls = String(el.className || '');
            if (/next|Next|turnRight|arrow-right|arrowRight/.test(cls) && el.clientWidth > 0 && el.clientWidth < 200) return el;
        }
        return null;
    }

    // 当前页的页码信息（“3/12”或新版缩略图 is-active 序号）
    function docPageInfo() {
        var thumbs = document.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            var cur = 0;
            for (var t = 0; t < thumbs.length; t++) {
                if (thumbs[t].classList.contains('is-active')) { cur = t + 1; break; }
            }
            return { cur: cur, total: thumbs.length };
        }
        var els = document.querySelectorAll(
            '[class*="pageNum"], [class*="page-num"], [class*="pageInfo"], [class*="page-info"], ' +
            '[class*="pager"], [class*="pagination"], [class*="indicator"], .zpgi, .zcnt'
        );
        for (var i = 0; i < els.length; i++) {
            var m = (els[i].textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
            if (m) return { cur: parseInt(m[1], 10), total: parseInt(m[2], 10) };
        }
        return null;
    }

    // 当前可见文档页的“指纹”（缩略图激活位 / 主图 src / 内容摘要），用于判断翻页是否生效
    function docPageSignature() {
        var scope = findDocViewer();
        if (!scope) return '';
        var thumbs = scope.querySelectorAll('.mooc-docs-reader__thumbnail, [class*="mooc-docs-reader__thumbnail"]');
        if (thumbs.length > 0) {
            var cur = 0;
            for (var t = 0; t < thumbs.length; t++) {
                if (thumbs[t].classList.contains('is-active')) { cur = t + 1; break; }
            }
            return 'reader:' + cur + '/' + thumbs.length;
        }
        var imgs = scope.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
            var im = imgs[i];
            if (isVisible(im) && im.src && im.clientWidth >= 100) return im.src;
        }
        var txt = scope.textContent || '';
        return String(txt.length) + ':' + txt.slice(-60);
    }

    // 没有翻页按钮的长文档：每 1 秒滚动一屏，滚不动即到底
    async function scrollDocFallback() {
        var viewer = findDocViewer();
        var sc = (viewer && viewer.scrollHeight > viewer.clientHeight + 40) ? viewer : (document.scrollingElement || document.documentElement);
        var before = sc.scrollTop;
        sc.scrollTop += Math.max(300, Math.min(800, window.innerHeight * 0.7));
        await sleep(CONFIG.LEARN_DOC_PAGE_MS);
        return sc.scrollTop > before + 10;
    }

    // 文档内容：自动翻页，每页停留 1 秒
    async function learnDocItem() {
        logDebug('doc', '开始自动翻页（每页 1 秒）...');
        updateStatus('📄 检测到文档，开始自动翻页（每页 1 秒）...');
        var flips = 0, stale = 0, lastSig = docPageSignature(), lastInfo = docPageInfo();
        while (!taskState.cancelled && flips < CONFIG.LEARN_MAX_PAGE_FLIPS) {
            // 用户点了【下一节】→ 跳过当前文档
            if (manualWaitFlag) { logDebug('doc', '用户点击【下一节】，跳过当前文档'); updateStatus('⏭ 用户点击【下一节】，跳过当前文档'); return true; }
            var btn = findDocNextBtn();
            if (!btn) {
                // 新版缩略图阅读器：没有下一页按钮就说明已在最后一页，直接完成
                var info = docPageInfo();
                if (info && info.total > 0) {
                    logDebug('doc', '翻页结束（已到最后一页 ' + info.cur + '/' + info.total + '）');
                    updateStatus('📄 文档翻页结束（已到最后一页），进入下一个内容');
                    return true;
                }
                var moved = await scrollDocFallback();
                if (!moved) { logDebug('doc', '已到文档末尾（无翻页按钮）'); updateStatus('📄 已到文档末尾（无翻页按钮），进入下一个内容'); return true; }
                continue;
            }
            realClick(btn);
            await sleep(CONFIG.LEARN_DOC_PAGE_MS);
            flips++;
            var sig = docPageSignature();
            var info2 = docPageInfo();
            var changed = (sig && sig !== lastSig) || (info2 && lastInfo && (info2.cur > lastInfo.cur || info2.total !== lastInfo.total));
            if (changed) { stale = 0; lastSig = sig || lastSig; lastInfo = info2 || lastInfo; }
            else {
                stale++;
                if (stale >= 3) { logDebug('doc', '翻页结束（连续 ' + stale + ' 页无变化）'); updateStatus('📄 文档翻页结束（已到最后一页），进入下一个内容'); return true; }
            }
            if (flips % 10 === 0) updateStatus('📄 文档翻页中... 已翻 ' + flips + ' 页');
        }
        logDebug('doc', '文档处理完成（翻 ' + flips + ' 页）');
        updateStatus('📄 文档处理完成，进入下一个内容');
        return true;
    }

    // 独立测验：只停留片刻（不自动作答，避免消耗答题次数）
    async function learnQuizItem() {
        updateStatus('📝 检测到独立测验内容：停留片刻，不自动作答（避免消耗答题次数），随后继续');
        await sleep(CONFIG.LEARN_QUIZ_VISIT_MS);
        await dismissModal();
        return true;
    }

    // 讨论内容：自动回复
    async function learnDiscussionItem() {
        updateStatus('💬 检测到讨论内容，自动回复...');
        await replyDiscussion();
        await sleep(1000);
        return true;
    }

    // 其它（富文本课件等）：停留片刻
    async function learnOtherItem() {
        updateStatus('📄 其它类型内容（富文本/网页课件），停留片刻后继续...');
        await sleep(CONFIG.LEARN_OTHER_VISIT_MS);
        return true;
    }

    // 在页面里找目标 ID 对应的目录链接（SPA 真实点击不会整页刷新）
    function findContentElById(id) {
        var links = learnContentLinks();
        for (var i = 0; i < links.length; i++) {
            if (links[i].id === id && links[i].el) return links[i].el;
        }
        return null;
    }

    // 宽松版：全页面找目标 ID 对应的链接（不要求归属到章），用于跳转兜底。
    // 安全约束：<a> 的 href 必须真的指向目标 ID（/content/{id} 或 id={id}），
    //           否则跳过——避免点到课程首页/公告这类杂项链接。
    function findAnyContentElById(id) {
        var els = document.querySelectorAll('a[href*="/content/"], a[href*="id="], [data-content-id], [data-id]');
        var coursePrefix = learnCoursePrefix();
        for (var i = 0; i < els.length; i++) {
            if (linkIdOf(els[i]) !== id) continue;
            if (els[i].tagName === 'A') {
                var ah = els[i].getAttribute('href') || '';
                if (!(new RegExp('/content/' + id + '(?![0-9])').test(ah) || ah.indexOf('id=' + id) !== -1)) continue;
                if (coursePrefix && ah.indexOf('#') !== 0 && ah.indexOf(coursePrefix) !== 0) continue;
            }
            return els[i];
        }
        return null;
    }

    // 构造新版路径路由的跳转地址：只替换 content/{id}，保留 tid，
    // 但清掉 unitId/chapterId——它们必须与新内容匹配，拿不到正确值宁可交给平台自己解析，
    // 也不能带旧的（否则平台报“unitId 与 lessonId 不匹配”课件不存在）。
    function buildContentUrl(id) {
        try {
            var u = new URL(location.href);
            u.pathname = u.pathname.replace(/\/content\/\d+/, '/content/' + id);
            var sp = new URLSearchParams(u.search);
            var tid = sp.get('tid');
            sp.delete('unitId'); sp.delete('chapterId'); sp.delete('sm');
            if (tid) sp.set('tid', tid);
            u.search = sp.toString();
            return u.href;
        } catch (e) {
            return location.href.replace(/\/content\/\d+/, '/content/' + id);
        }
    }

    // 跳转到指定内容。target 可以是 {id, href, el}，也可以是数字 id。
    // 新版路径路由（/content/{id}?tid=...&unitId=...&chapterId=...）与旧版 hash 路由都支持。
    // 顺序：① 真实点击目录里的链接（SPA 内部路由，不刷新、参数全对）；
    //       ② 用目录链接的完整 href 跳转（含正确 unitId/chapterId）；
    //       ③ 都没有时按当前 URL 换 content id（并清掉可能不匹配的 unitId/chapterId）。
    // 安全约束：点击/使用某个链接前，必须确认它的 href 真的指向目标 ID，
    //           否则宁可自己构造 URL，也不点杂项链接（避免跳到 content/3 这种假地址）。
    async function gotoContent(target) {
        var id = (typeof target === 'object' && target) ? target.id : target;
        var href = (typeof target === 'object' && target) ? (target.href || '') : '';
        var el = (typeof target === 'object' && target && target.el) || findContentElById(id) || findAnyContentElById(id);
        if (el) {
            var elHref = (el.getAttribute && el.getAttribute('href')) || '';
            // 只采纳「href 里明确含目标 ID」的完整链接；其余一律当没有
            if (elHref && elHref.indexOf('#') !== 0 &&
                (new RegExp('/content/' + id + '(?![0-9])').test(elHref) || elHref.indexOf('id=' + id) !== -1)) {
                href = elHref;
            } else {
                el = null; // href 与目标 ID 对不上：不点击、不使用
            }
        }

        if (el && el.tagName === 'A' && isVisible(el)) {
            try { realClick(el); } catch (e) {}
            await sleep(600);
            if (learnCurrentContentId() === id) { await sleep(400); return; }
            // 没生效，继续走 URL 跳转兜底
        }

        var curHref = location.href, curHash = location.hash;
        var next = null;
        if (href) {
            if (href.indexOf('#') !== -1) {
                var hashPart = href.slice(href.indexOf('#'));
                if (/id=(\d+)/.test(hashPart)) next = hashPart; // 旧版：沿用目录链接的 hash
            } else if (/\/content\/\d+/.test(href) || /\/mooc\/learn\//.test(href)) {
                next = href; // 新版：完整链接（含 tid/unitId/chapterId，参数正确）
            }
        }
        if (!next) {
            if (/\/content\/\d+/.test(curHref)) {
                next = buildContentUrl(id); // 保留 tid，清掉可能不匹配的 unitId/chapterId
            } else if (/id=\d+/.test(curHash)) {
                next = curHash.replace(/id=\d+/, 'id=' + id); // 旧版 hash 路由
            }
        }
        if (next) {
            if (next.indexOf('#') === 0) { if (next !== curHash) location.hash = next; }
            else { if (next !== curHref) location.href = next; }
        }
        var t0 = Date.now();
        while (Date.now() - t0 < CONFIG.LEARN_NAV_WAIT) {
            if (taskState.cancelled) throw makeCancelError();
            if (learnCurrentContentId() === id) { await sleep(500); return; }
            await sleep(250);
        }
    }

    // 判定“当前是不是讨论页”要偏严：自动学习里若误判，会把回复文本填进搜索框。
    // 要求有 hash 特征，或命中了回复列表容器，或编辑器周围带明显的回复/评论字样。
    function looksLikeDiscussionPage() {
        if (/forumdetail|forum|discuss|discussion|topic/i.test(location.hash)) return true;
        if (collectCandidates(document, DISCUSS.listSelectors, 10).length > 0) return true;
        var els = document.querySelectorAll('textarea, [contenteditable="true"]');
        for (var i = 0; i < els.length; i++) {
            if (!isVisible(els[i])) continue;
            var scope = els[i].closest('[class*="reply"], [class*="comment"], [class*="editor"], [class*="discuss"], [class*="post"], form');
            if (scope) {
                var txt = cleanText(scope.textContent).slice(0, 200);
                if (/回复|评论|发表|发布|讨论/.test(txt)) return true;
            }
        }
        return false;
    }

    // 当前页面类型：quiz / discussion / video / doc / other
    function detectContentType() {
        var href = location.href, hash = location.hash;
        // 课件加载失败页（unitId 与 lessonId 不匹配等）→ 快速跳过，不停留
        var bodyHead = cleanText((document.body ? document.body.textContent : '') || '').slice(0, 300);
        if (/课件不存在|课件加载失败|unitId[\s\S]{0,20}不匹配|lessonId[\s\S]{0,20}不匹配|内容不存在|资源不存在/.test(bodyHead)) { logDebug('type', 'missing：页面显示课件不存在/unitId不匹配类文案'); return 'missing'; }
        if (PAGE_CONFIG.quizUrl.test(href) || hasVisibleQuestionBlocks()) { logDebug('type', 'quiz：URL 命中测验路由或检测到题目块'); return 'quiz'; }
        if (looksLikeDiscussionPage()) { logDebug('type', 'discussion：讨论页特征命中'); return 'discussion'; }
        if (findVideo()) { logDebug('type', 'video：检测到可见 video 元素'); return 'video'; }
        if (findDocViewer()) { logDebug('type', 'doc：检测到文档查看器'); return 'doc'; }
        logDebug('type', 'other：未命中视频/文档/讨论/测验特征（富文本/节标题页等）');
        return 'other';
    }

    // ---- 自动学习的跨页面续跑状态 ----
    // 新版 UI 是路径路由：跳转内容 = 整页刷新，页面刷新后脚本重新初始化，
    // 内存里的循环会断掉。所以把「计划」写进 localStorage，每次刷新后由
    // resumeLearn() 接着跑；点“停止”或手动切走则清除状态。
    var LEARN_STATE_KEY = 'mar.learn.state.v2'; // v2：清掉旧版残留的脏计划

    function learnSaveState(st) {
        try { localStorage.setItem(LEARN_STATE_KEY, JSON.stringify(st)); } catch (e) {}
    }
    function learnLoadState() {
        try {
            var s = localStorage.getItem(LEARN_STATE_KEY);
            if (!s) return null;
            var o = JSON.parse(s);
            return o && o.running ? o : null;
        } catch (e) { return null; }
    }
    function learnClearState() {
        try { localStorage.removeItem(LEARN_STATE_KEY); } catch (e) {}
    }

    // ===================== 新版 DOM 导航核心（tablist + 章节/小节下拉） =====================
    // 页面结构（用户提供）：
    //   · 顶部导航：章节/小节下拉按钮 <button aria-expanded="false" aria-label="章节名/小节名" type="button">
    //   · 内容标签栏：<div role="tablist"> 内多个 <button role="tab" aria-label="内容名" type="button">，
    //     当前激活的带 aria-selected="true"
    //   · SPA 单页应用：跳转一律用 .click() 模拟点击，绝不直接改 URL
    // 跳转优先级：①同小节（tab 下一个兄弟）→ ②跨小节（小节下拉下一项）→ ③跨章节（章节下拉下一章）

    // 通用：等待元素出现（Promise），超时返回 null；中途取消也返回 null
    function waitForElement(selector, timeout, root) {
        return new Promise(function (resolve) {
            var t0 = Date.now();
            (function check() {
                if (taskState.cancelled) { resolve(null); return; }
                var el;
                try { el = (root || document).querySelector(selector); } catch (e) { el = null; }
                if (el && isVisible(el)) { resolve(el); return; }
                if (Date.now() - t0 >= timeout) { resolve(null); return; }
                setTimeout(check, 200);
            })();
        });
    }

    // 等待某个内容标签成为激活项（aria-selected=true）
    async function waitForTabActive(tab) {
        var t0 = Date.now();
        while (Date.now() - t0 < CONFIG.LEARN_NAV_WAIT) {
            if (taskState.cancelled) return false;
            if (tab && tab.getAttribute('aria-selected') === 'true') return true;
            await sleep(200);
        }
        return !!(tab && tab.getAttribute('aria-selected') === 'true');
    }

    // 当前激活的内容标签（[role="tab"][aria-selected="true"] 中可见的那个）
    function currentContentTab() {
        var tabs = document.querySelectorAll('[role="tab"][aria-selected="true"]');
        for (var i = 0; i < tabs.length; i++) if (isVisible(tabs[i])) return tabs[i];
        return null;
    }

    // 收集全部可见的内容标签
    function contentTabs() {
        var out = [];
        var lists = document.querySelectorAll('[role="tablist"]');
        for (var l = 0; l < lists.length; l++) {
            var ts = lists[l].querySelectorAll('[role="tab"]');
            for (var i = 0; i < ts.length; i++) if (isVisible(ts[i])) out.push(ts[i]);
        }
        return out;
    }

    // 顶部导航里的章节/小节下拉按钮。
    // 真实页面（用户提供）：
    //   · 章节按钮 aria-label="第四章 坚持以人民为中心"（匹配章标题）
    //   · 小节按钮 aria-label="4.2.2 依靠人民创造历史伟业"（数字编号 + 名字）
    //   · 干扰按钮：两个无 label 的 learn-header-action、「更多课程操作」learn-header-more-toggle、
    //     「打开文科AI助教」learn-agent-launcher —— 必须排除，否则小节按钮会被「更多课程操作」抢走，
    //     导致跨小节时展开错误的下拉 → 匹配失败 → 误判“小节已结束” → 误跳章节。
    function headerDropdowns() {
        var btns = document.querySelectorAll('header button[aria-expanded], [class*="header"] button[aria-expanded], nav button[aria-expanded], button[aria-expanded]');
        var chapter = null, section = null;
        for (var i = 0; i < btns.length; i++) {
            if (!isVisible(btns[i])) continue;
            var label = btns[i].getAttribute('aria-label') || '';
            if (!label) continue;
            var cls = typeof btns[i].className === 'string' ? btns[i].className : (btns[i].getAttribute ? (btns[i].getAttribute('class') || '') : '');
            // 黑名单：排除平台的功能按钮（更多课程操作 / 文科AI助教 / 无意义的 header-action）
            if (/learn-header-action|learn-header-more|learn-agent|more-toggle|more-menu/.test(cls)) continue;
            if (/更多课程操作|打开.*助教|更多|收起|关闭/.test(label)) continue;
            if (looksLikeChapterHeading(label)) { if (!chapter) chapter = btns[i]; }
            else { if (!section) section = btns[i]; }
        }
        logDebug('nav', '章节按钮=' + (chapter ? (chapter.getAttribute('aria-label') || '?') : '未找到')
            + ' | 小节按钮=' + (section ? (section.getAttribute('aria-label') || '?') : '未找到'));
        return { chapter: chapter, section: section };
    }

    // 下拉菜单里“可点项”的候选选择器（下拉展开后的 DOM 未知，多给几组候选）
    function menuItemSels() {
        return [
            '[role="menuitem"]', '[role="option"]', '[class*="menuitem"]', '[class*="menu-item"]',
            '[class*="dropdown"] a', '[class*="dropdown"] li', '[class*="dropdown"] button',
            '[class*="popover"] a', '[class*="popover"] li', '[class*="popup"] a', '[class*="popup"] li',
            '[class*="option"]', '[class*="choice"]', '[class*="select"] a', '[class*="select"] li',
            'a', 'li', 'button',
        ];
    }

    // 展开下拉按钮，返回展开后的面板容器（找不到返回 null）。
    // 健壮策略：点击前记录候选面板 → 点击 → 优先找「新出现」的面板；
    // 若下拉本就处于展开态（无新面板），则返回按钮祖先里任意可见面板，
    // 保证「已展开状态下重新取菜单」也能命中。
    async function expandDropdown(btn) {
        if (!btn) return null;
        var before = collectCandidates(document, ['[role="menu"]', '[role="listbox"]', '[class*="dropdown"]', '[class*="popover"]', '[class*="popup"]', '[class*="select-list"]'], 40);
        if (btn.getAttribute('aria-expanded') !== 'true') { realClick(btn); }
        await sleep(400);
        var fallbackPanel = null;
        // 1) 从按钮向上找父容器里的面板（优先新出现，其次任意可见）
        var node = btn;
        for (var depth = 0; node && depth < 5; depth++) {
            var parent = node.parentElement;
            if (!parent) break;
            var sels = ['[role="menu"]', '[role="listbox"]', '[class*="dropdown-menu"]', '[class*="dropdown"]', '[class*="popover"]', '[class*="popup"]'];
            for (var s = 0; s < sels.length; s++) {
                var p;
                try { p = parent.querySelector(sels[s]); } catch (e) { continue; }
                if (p && isVisible(p)) {
                    if (before.indexOf(p) === -1) return p;
                    if (!fallbackPanel) fallbackPanel = p;
                }
            }
            node = parent;
        }
        // 2) 全页面：优先新出现的面板，其次任意可见面板
        var els = document.querySelectorAll('[role="menu"], [role="listbox"], [class*="dropdown-menu"], [class*="dropdown"], [class*="popover"], [class*="popup"]');
        var anyPanel = null;
        for (var i = 0; i < els.length; i++) {
            if (isVisible(els[i])) {
                if (before.indexOf(els[i]) === -1) return els[i];
                if (!anyPanel) anyPanel = els[i];
            }
        }
        return anyPanel || fallbackPanel || null;
    }

    // 判断元素是不是「可点击单元」：a / button / li / option / menuitem / tab
    function isClickableEl(el) {
        var tag = el.tagName;
        if (tag === 'A' || tag === 'BUTTON' || tag === 'LI') return true;
        var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
        return role === 'option' || role === 'menuitem' || role === 'tab' || role === 'button';
    }

    // 取菜单项的完整文本：如果元素是内部碎片（span 等），提升到它的可点父级（a/li/button）再取文本。
    // 关键：真实菜单项常是 <li><a><span>4.1.3</span><span>人民立场…</span></a></li>，
    // 若只读 span 会得到不完整文本，导致与按钮 aria-label 匹配失败 → 误判“没下一项” → 误跳章节。
    function itemFullText(el) {
        var node = el;
        if (el.closest) {
            var up = el.closest('a, li, button, [role="option"], [role="menuitem"], [role="tab"]');
            if (up && up !== el) node = up;
        }
        return cleanText(node.textContent).slice(0, 40);
    }

    // 从候选里保留「最外层的可点单元」：有可点祖先在集合里的碎片（span/div）一律丢弃；
    // 若某项没有可点祖先（纯 div/span 菜单），则原样保留。
    function dedupeClickable(raw) {
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var el = raw[i];
            var skip = false;
            for (var j = 0; j < raw.length; j++) {
                if (i !== j && raw[j] !== el && raw[j].contains(el) && isClickableEl(raw[j])) { skip = true; break; }
            }
            if (!skip) out.push(el);
        }
        return out;
    }

    // 从候选里保留「最外层的可点单元」，并按 DOM 顺序排序。
    function menuItemsOf(panel) {
        var raw = collectCandidates(panel, menuItemSels(), 160);
        var out = dedupeClickable(raw);
        out.sort(function (a, b) {
            if (a.compareDocumentPosition && b.compareDocumentPosition) {
                return (a.compareDocumentPosition(b) & 4) ? -1 : 1;
            }
            return 0;
        });
        return out;
    }

    // 展开下拉后返回菜单项列表。
    // 优先用面板内的候选；面板找不到时，用「点击前后新出现的可点项」兜底
    // （展开前记录候选 → 展开后 diff，新出现的项基本就是菜单项）。
    // 菜单内容多时可以滚动（用户反馈）：若面板内没取到项，先把面板滚到底/中间，
    // 触发懒渲染/虚拟列表补全后再收一次。
    async function findDropdownItems(btn) {
        var before = collectCandidates(document, menuItemSels(), 160);
        var panel = await expandDropdown(btn);
        var items = []; // 必须初始化：panel 为 null 时保持空数组，避免后续 items.length 崩溃
        if (panel) {
            items = menuItemsOf(panel);
            if (items.length === 0 && panel.scrollTop !== undefined) {
                try { panel.scrollTop = panel.scrollHeight; } catch (e) {}
                await sleep(400);
                items = menuItemsOf(panel);
            }
            if (items.length > 0) return items;
        }
        var after = collectCandidates(document, menuItemSels(), 160);
        var news = [];
        for (var i = 0; i < after.length; i++) {
            if (before.indexOf(after[i]) === -1) news.push(after[i]);
        }
        var out = dedupeClickable(news);
        logDebug('menu', '下拉项(面板模式)=' + items.length + ' → diff兜底=' + out.length
            + ' | 面板=' + (panel ? (panel.className ? String(panel.className).slice(0, 40) : panel.tagName) : 'null'));
        return out;
    }

    // 点击下拉菜单选项：先提升到可点父级（span → a/li/button，点击才有效），
    // 再滚入面板可视区（长菜单/虚拟列表可能未渲染），最后模拟点击。
    function clickMenuItem(el) {
        var target = el;
        if (el.closest) {
            var up = el.closest('a, li, button, [role="option"], [role="menuitem"], [role="tab"]');
            if (up && up !== el) target = up;
        }
        try { if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        realClick(target);
    }

    // 分组标题识别：小节下拉里「第一节 xxx / 第二节 xxx」这类是节的分组标题，
    // 不是可点进入的内容单元（真实内容单元形如 4.1.1 / 4.2.2）。
    // 匹配/取下一个时必须跳过它们，否则当前节最后一个内容学完时，
    // 「下一个」会拿到分组标题而不是下一节的具体内容。
    // 注意：只认「第X节」，不能误伤章节名（第四章/第五章等 —— 章节下拉菜单里全是章名）。
    function isGroupTitle(t) {
        return /^第[一二三四五六七八九十百\d]+\s*节/.test(t) && !/^\s*\d+(\.\d+)+/.test(t);
    }

    // 匹配用归一化文本：去掉所有空白再比较。
    // 关键：菜单项常是 <a><span>4.1.3</span><span>人民立场…</span></a>，
    // textContent 是「4.1.3人民立场…」（无空格），而按钮 aria-label 是「4.1.3 人民立场…」（有空格），
    // 不去空白会匹配失败 → 误判“没下一项” → 误跳章节。
    function normMatch(s) {
        return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');
    }

    // 在菜单项里找「文本与 currentLabel 相似」的项，返回它的下一个；没有下一个返回 null。
    // 文本相似 = 相等 / 互相包含（归一化空白后比较，精确匹配优先，包含关系兜底）。
    // 文本一律用 itemFullText 取（提升到可点父级），避免 span 碎片导致匹配失败。
    // 注意：分组标题（第一节/第二节）也参与匹配和取下一个 —— 有些课程里节标题本身可点
    // （点它进入该节），直接跳过会让用户觉得“第一节/第二节被跳过”。不可点时由
    // doSectionJump 的兜底逻辑改点该节第一个内容单元。
    function nextOfMenuItems(items, currentLabel) {
        if (!items || items.length === 0) return null;
        var target = normMatch(currentLabel);
        var idx = -1;
        for (var i = 0; i < items.length; i++) {
            var full = itemFullText(items[i]);
            var t = normMatch(full);
            if (!t) continue;
            if (target && (t === target || t.indexOf(target) !== -1 || target.indexOf(t) !== -1)) { idx = i; break; }
        }
        if (idx === -1) return null; // 没找到当前项，无法确定“下一个”
        var ret = (idx + 1 < items.length) ? items[idx + 1] : null;
        logDebug('menu', '匹配「' + (String(currentLabel || '').slice(0, 20)) + '」→ idx=' + idx
            + (ret ? '，下一个=「' + itemFullText(ret).slice(0, 24) + '」' : '，无下一个（当前是最后一项）'));
        return ret;
    }

    // —— 跳转三级逻辑 ——

    // 判断内容标签是不是「测验」（按 aria-label / 文本关键词，命中即视为测验）
    function tabIsQuiz(tab) {
        var label = (tab.getAttribute && (tab.getAttribute('aria-label') || '')) || '';
        var txt = cleanText((tab.textContent || '')).slice(0, 30);
        return /测验|测试|考试|自测|小测|quiz/i.test(label) || /测验|测试|考试|自测|小测|quiz/i.test(txt);
    }

    // 从当前标签向后找「下一个非测验」的内容标签（跳过测验，满足“测验连进入都不要进入”）
    function nextTabSkipQuiz(fromTab) {
        var s = fromTab, skipped = [];
        while (s) {
            s = s.nextElementSibling;
            if (!s) return null;
            if (s.getAttribute && s.getAttribute('role') === 'tab' && isVisible(s)) {
                if (tabIsQuiz(s)) { skipped.push(cleanText((s.textContent || '')).slice(0, 12)); continue; } // 跳过测验标签
                if (skipped.length) logDebug('nav', '同小节内跳过测验标签：' + skipped.join('、'));
                return s;
            }
        }
        return null;
    }

    // 标签列表里第一个非测验的（跨小节/章节后自动点它）
    function firstNonQuizTab(tabs) {
        for (var i = 0; i < tabs.length; i++) {
            if (!tabIsQuiz(tabs[i])) return tabs[i];
        }
        return null;
    }

    // 等待内容标签栏完成切换：出现「不是旧激活元素」的新 tab 才算切换成功。
    // 关键：SPA 框架（React/Vue）会复用 tablist 容器、替换内部 tab 元素，
    // 所以必须用「元素身份变化」判断（旧元素被新元素替换），不能用 waitForElement
    // 命中容器里已存在的旧元素——否则会点到上一节的内容。
    async function waitForTablistRefresh(oldTab) {
        var t0 = Date.now();
        while (Date.now() - t0 < 10000) {
            if (taskState.cancelled) return null;
            var tabs = contentTabs();
            if (tabs.length > 0) {
                var changed = false;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i] !== oldTab) { changed = true; break; }
                }
                if (changed) {
                    logDebug('nav', 'tablist 已刷新：' + tabs.length + ' 个内容标签，等待耗时 ' + (Date.now() - t0) + 'ms');
                    return tabs;
                }
            }
            await sleep(200);
        }
        logDebug('nav', '⚠️ tablist 刷新超时（10 秒内旧元素未被替换）');
        return null;
    }

    // 展开「小节」下拉，返回「下一个小节」选项；当前小节是最后一项（无下一项）返回 null。
    // 无下一项时顺手收起下拉，避免残留影响后续章节跳转。
    async function pickNextSectionItem() {
        var dd = headerDropdowns();
        if (!dd.section) { logDebug('nav', '⚠️ 未找到「小节」下拉按钮'); return null; }
        var name = dd.section.getAttribute('aria-label') || '';
        logDebug('nav', '跨小节决策：小节名=「' + name.slice(0, 24) + '」');
        var items = await findDropdownItems(dd.section);
        var next = nextOfMenuItems(items, name);
        if (!next) {
            logDebug('nav', '小节下拉无下一项 → 判定当前小节是本章最后一项，进入跨章节');
            if (dd.section.getAttribute('aria-expanded') === 'true') realClick(dd.section);
            return null;
        }
        logDebug('nav', '跨小节目标=「' + itemFullText(next).slice(0, 24) + '」');
        return next;
    }

    // 展开「章节」下拉，返回「下一个章节」选项；无下一项（全部章节学完）返回 null。
    async function pickNextChapterItem() {
        var dd = headerDropdowns();
        if (!dd.chapter) { logDebug('nav', '⚠️ 未找到「章节」下拉按钮'); return null; }
        var name = dd.chapter.getAttribute('aria-label') || '';
        logDebug('nav', '跨章节决策：章节名=「' + name.slice(0, 24) + '」');
        var items = await findDropdownItems(dd.chapter);
        var next = nextOfMenuItems(items, name);
        if (!next) {
            logDebug('nav', '章节下拉无下一项 → 判定全部章节学完');
            if (dd.chapter.getAttribute('aria-expanded') === 'true') realClick(dd.chapter);
            return null;
        }
        logDebug('nav', '跨章节目标=「' + itemFullText(next).slice(0, 24) + '」');
        return next;
    }

    // 执行跨小节：点击小节选项 → 等新 tablist → 点第一个非测验内容标签
    // 兜底：点击的是分组标题（第一节/第二节）且平台不响应（tablist 未刷新）时，
    // 自动改点该分组标题后面的第一个内容单元，保证不会卡在“节标题被跳过/无反应”。
    async function doSectionJump(item) {
        var oldTab = currentContentTab();
        clickMenuItem(item);
        updateStatus('📚 跨小节：进入下一节，自动播放第一个内容...');
        var tabs = await waitForTablistRefresh(oldTab);
        if (!tabs || tabs.length === 0) {
            // 分组标题可能只是定位/无点击效果：改点该节第一个内容单元
            logDebug('nav', '⚠️ 点击「' + itemFullText(item).slice(0, 20) + '」后 tablist 未刷新，改点该节第一个内容单元');
            var dd = headerDropdowns();
            if (dd.section) {
                var items = await findDropdownItems(dd.section);
                var idx = items.indexOf(item);
                var nextContent = null;
                for (var j = idx + 1; j < items.length; j++) {
                    var ft = itemFullText(items[j]);
                    if (ft && !isGroupTitle(ft)) { nextContent = items[j]; break; }
                }
                if (nextContent) {
                    clickMenuItem(nextContent);
                    tabs = await waitForTablistRefresh(oldTab);
                }
            }
        }
        if (!tabs || tabs.length === 0) return false;
        var first = firstNonQuizTab(tabs) || tabs[0];
        realClick(first);
        await waitForTabActive(first);
        return true;
    }

    // 执行跨章节：点击章节选项 → 等新 tablist（必要时先点第一个小节）→ 点第一个非测验内容标签
    async function doChapterJump(item) {
        var oldTab = currentContentTab();
        clickMenuItem(item);
        updateStatus('📕 跨章节：进入下一章，自动播放第一个内容...');
        var tabs = await waitForTablistRefresh(oldTab);
        if (!tabs || tabs.length === 0) {
            // 若平台未自动选中第一小节，展开小节下拉点第一项
            var dd2 = headerDropdowns();
            if (dd2.section) {
                var items2 = await findDropdownItems(dd2.section);
                if (items2.length > 0) { clickMenuItem(items2[0]); await sleep(600); }
            }
            tabs = await waitForTablistRefresh(oldTab);
        }
        if (!tabs || tabs.length === 0) return false;
        var first = firstNonQuizTab(tabs) || tabs[0];
        realClick(first);
        await waitForTabActive(first);
        return true;
    }

    // 主跳转入口（严格三级优先级：同小节 → 跨小节 → 跨章节 → 结束）
    // 关键修复：跨小节必须先确认「小节下拉里确实有下一项」才执行；
    // 只有确认当前小节是最后一项，才会进入跨章节——从根上杜绝“节没学完就跳章”。
    async function goNext() {
        // 当前激活的内容标签（页面加载慢时等它出现）
        var curTab = currentContentTab();
        if (!curTab) {
            logDebug('nav', '当前激活 tab 未找到，等待出现...');
            curTab = await waitForElement('[role="tab"][aria-selected="true"]', 5000);
            if (!curTab) { logDebug('nav', '❌ 5 秒后仍无激活 tab'); updateStatus('❌ 未找到当前内容标签，无法跳转'); return false; }
        }
        logDebug('nav', 'goNext 入口：当前激活 tab=「' + (curTab.getAttribute('aria-label') || cleanText(curTab.textContent).slice(0, 20)) + '」');
        // 优先级 1：同小节内 —— 向后找下一个「非测验」内容标签
        var target = nextTabSkipQuiz(curTab);
        if (target) {
            realClick(target);
            updateStatus('➡️ 同小节：进入下一个内容');
            logDebug('nav', '优先级1 同小节：点击「' + (target.getAttribute('aria-label') || cleanText(target.textContent).slice(0, 20)) + '」');
            await waitForTabActive(target);
            return true;
        }
        logDebug('nav', '优先级1 无下一个同小节 tab（已到本节末尾）');
        // 优先级 2：跨小节 —— 先确认小节下拉里确有下一项
        var secItem = await pickNextSectionItem();
        if (secItem) {
            if (await doSectionJump(secItem)) return true;
            // 跨小节执行失败（点击了但内容未加载）：重试一次，绝不误跳章节
            updateStatus('⚠️ 跨小节执行失败，10 秒后自动重试...');
            logDebug('nav', '⚠️ 跨小节失败，10 秒后重试');
            await sleepWhile(10000, function () { return manualWaitFlag; });
            secItem = await pickNextSectionItem();
            if (secItem && await doSectionJump(secItem)) return true;
            logDebug('nav', '⚠️ 跨小节连续失败');
            updateStatus('⚠️ 跨小节连续失败：请手动点击「小节」下拉切换，或检查顶部按钮结构');
            return false;
        }
        // 优先级 3：跨章节 —— 已确认当前小节是本章最后一项
        var chapItem = await pickNextChapterItem();
        if (chapItem) {
            if (await doChapterJump(chapItem)) return true;
            logDebug('nav', '⚠️ 跨章节执行失败');
            updateStatus('⚠️ 跨章节执行失败：请手动点击「章节」下拉切换，或检查顶部按钮结构');
            return false;
        }
        // 结束状态：所有查找都返回 null
        logDebug('nav', '🏁 三级跳转全部无目标 → 课程学习完成');
        alert('课程学习完成！');
        return false;
    }

    // 富文本/节标题页等正文是否已经渲染出来（避免内容还没加载完就跳走）
    function hasVisibleContentBody() {
        var sels = [
            'main p', 'main h1', 'main h2', 'main h3', 'main h4',
            '[class*="content"] p', '[class*="content"] h1', '[class*="content"] h2', '[class*="content"] h3',
            '[class*="lesson"] p', '[class*="learn-content"] p', '[class*="rich-text"] p',
            '[class*="section-title"]', '[class*="chapter-title"]', '[class*="lesson-title"]',
            '[class*="learn-section"]', '[class*="learn-lesson-title"]',
        ];
        var hits = collectCandidates(document, sels, 80);
        for (var i = 0; i < hits.length; i++) {
            var el = hits[i];
            if (!isVisible(el)) continue;
            var t = cleanText((el.textContent || '')).slice(0, 80);
            if (!t || t.length < 2) continue;
            // 排除脚本面板/导航等 UI 外壳文本与加载占位
            if (/MOOC 助手|自动学习|停止当前操作|页面 DOM 诊断|开始自动学习|加载中|loading|努力加载/.test(t)) continue;
            var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (r && (r.width < 60 || r.height < 20)) continue;
            return true;
        }
        return false;
    }

    // 等待当前内容真正加载出来（SPA 异步渲染）。
    // 视频/文档/讨论/富文本正文任一出现即算就绪；超时仍未出现 → 返回 false（按加载失败处理）。
    async function waitContentReady(timeout) {
        var t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            if (taskState.cancelled) return false;
            if (findVideo()) { logDebug('load', '内容就绪：video（' + (Date.now() - t0) + 'ms）'); return true; }
            if (findDocViewer()) { logDebug('load', '内容就绪：文档查看器（' + (Date.now() - t0) + 'ms）'); return true; }
            if (looksLikeDiscussionPage()) { logDebug('load', '内容就绪：讨论页（' + (Date.now() - t0) + 'ms）'); return true; }
            if (hasVisibleContentBody()) { logDebug('load', '内容就绪：富文本/标题页正文（' + (Date.now() - t0) + 'ms）'); return true; }
            await sleep(500);
        }
        logDebug('load', '⚠️ 内容加载超时（' + timeout + 'ms 内未见任何正文）');
        return false;
    }

    // —— 自动学习主流程 ——

    // 处理当前内容（视频/文档/测验/讨论），然后自动进入下一个内容
    async function learnOne() {
        var st = learnLoadState();
        if (!st) { setFloatVisible(false); return; }
        // 上一轮跳转完成，清掉「用户点了【下一节】」的标志，避免误跳过本轮内容
        manualWaitFlag = false;
        await sleep(500);
        await dismissModal();
        // 等当前内容真正加载出来（修复：文档/课件还没渲染完就跳转）
        updateStatus('⏳ 等待内容加载...');
        var ready = await waitContentReady(CONFIG.LEARN_CONTENT_READY_WAIT);
        if (taskState.cancelled) { learnClearState(); setFloatVisible(false); return; }
        var type;
        if (!ready) {
            updateStatus('⚠️ 内容加载超时（15 秒未渲染出来），按加载失败跳过...');
            type = 'missing';
        } else {
            type = detectContentType();
        }
        var done = true;

        if (type === 'missing') {
            // 课件加载失败（unitId/lessonId 不匹配等）→ 快速跳过
            logDebug('learn', 'missing：跳过，进入下一个内容');
            updateStatus('⚠️ 内容加载失败，尝试进入下一个内容...');
            done = true;
        } else if (type === 'video' && st.lastType === 'video') {
            // 连续视频跳过：不视频接视频
            logDebug('learn', '连续视频：跳过当前视频（不视频接视频）');
            updateStatus('⏭ 跳过连续视频（不视频接视频），进入下一个内容...');
            done = true;
        } else if (type === 'video') {
            done = await learnVideoItem();
        } else if (type === 'doc') {
            done = await learnDocItem();
        } else if (type === 'quiz') {
            // 测验：导航时已尽量跳过不进入；万一进来了也直接跳过，绝不停留作答
            logDebug('learn', 'quiz：测验内容直接跳过不进入');
            updateStatus('⏭ 测验内容：跳过（不进入作答），直接进入下一个内容...');
            done = true;
        } else if (type === 'discussion') {
            done = await learnDiscussionItem();
        } else {
            // 富文本等其它内容：停留 10 秒后自动跳转（可随时点右下角【下一节】提前跳）
            logDebug('learn', 'other：富文本/标题页，停留 ' + CONFIG.LEARN_OTHER_VISIT_MS + 'ms 后跳转');
            updateStatus('📄 富文本内容：停留 10 秒后自动跳转（可点右下角【下一节】提前跳）...');
            await sleepWhile(CONFIG.LEARN_OTHER_VISIT_MS, function () { return manualWaitFlag; });
            done = true;
        }
        if (taskState.cancelled || !done) {
            if (taskState.cancelled) updateStatus('⏹ 已停止当前操作');
            learnClearState();
            setFloatVisible(false);
            return;
        }

        // 记录上一个内容的类型（用于连续视频跳过）
        st.lastType = type;
        learnSaveState(st);

        // 所有类型统一自动进入下一个内容
        var ok = await goNext();
        if (!ok) { learnClearState(); setFloatVisible(false); return; }
        await learnOne();
    }

    // 用户点击「开始自动学习」：从当前内容开始处理，不跳转
    async function learnChapter() {
        if (!/\/learn\//.test(location.pathname) && !/\/spoc\/learn\//.test(location.pathname)) {
            updateStatus('⚠️ 自动学习只在新版学习页可用（请先进入课程学习页的某个内容）');
            return;
        }
        // 关掉平台自带的“自动播放下一集”，避免和我们自己的跳转抢节奏
        var autoNext = document.querySelector('input.j-autoNext');
        if (autoNext && autoNext.checked) { realClick(autoNext); updateStatus('已关闭平台自带的“自动播放下一集”'); }

        learnSaveState({ running: true, course: location.pathname.replace(/\/content\/\d+.*$/, '') || location.pathname, lastType: null });
        setFloatVisible(true);
        logDebug('learn', '🚀 手动开始自动学习，课程=' + location.pathname.slice(0, 60));
        updateStatus('🚀 自动学习开始：从当前内容处理，视频看完自动进入下一个内容...');
        await learnOne();
    }

    // 页面初始化时调用：若 localStorage 里还有未完成的自动学习且课程没变，接着跑
    function resumeLearn() {
        var st = learnLoadState();
        if (!st) return;
        if (st.course && location.pathname.indexOf(st.course) !== 0) { learnClearState(); return; }
        taskState.running = true;
        taskState.cancelled = false;
        setButtonsRunning(true);
        setFloatVisible(true);
        logDebug('learn', '▶ 页面刷新，自动学习已恢复（lastType=' + (st.lastType || 'null') + '）');
        updateStatus('▶ 自动学习已恢复...');
        Promise.resolve().then(learnOne).catch(function (err) {
            if (err && err.__cancelled) updateStatus('⏹ 已停止当前操作');
            else { logDebug('err', '自动学习异常：' + (err && err.message)); console.error('[auto-learn]', err); updateStatus('❌ 自动学习异常：' + (err && err.message)); }
        }).then(function () {
            // 只有学习真正结束/被停止时才收尾；等待【下一节】时状态仍在，不收尾
            if (!learnLoadState()) {
                taskState.running = false;
                taskState.cancelled = false;
                setButtonsRunning(false);
                setFloatVisible(false);
            }
        });
    }

    // —— 悬浮【下一节】按钮 ——
    // 用途：① 富文本内容停留期间，点它提前结束等待并进入下一个内容；
    //       ② 视频播放中/文档翻页中，点它立即跳过当前内容。
    // 机制：点击只置 manualWaitFlag 标志，当前内容处理循环检测到标志会提前结束，
    //       然后由 learnOne 统一走 goNext —— 避免按钮直接跳转造成双重跳转。
    var manualWaitFlag = false;

    function createFloatNextBtn() {
        if (document.getElementById('mar-float-next')) return;
        var btn = document.createElement('button');
        btn.id = 'mar-float-next';
        btn.textContent = '下一节';
        btn.title = '立即进入下一个内容（视频/文档/富文本都适用）';
        btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:999999;padding:10px 20px;font-size:14px;color:#fff;background:#e86e4f;border:none;border-radius:20px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.3);display:none;';
        btn.addEventListener('click', function () {
            if (!taskState.running) return;
            manualWaitFlag = true;
            updateStatus('⏩ 已请求进入下一个内容...');
        });
        document.body.appendChild(btn);
    }

    function setFloatVisible(v) {
        var b = document.getElementById('mar-float-next');
        if (b) b.style.display = v ? 'block' : 'none';
    }

    // ===================== 页面 DOM 诊断 =====================
    // 新版 UI 如果改了讨论区类名，点这个按钮会把当前页面的候选结构导出来，
    // 复制给作者即可精准适配；不会改动页面任何东西。
    function probeDiscussionDom() {
        var lines = [];
        lines.push('URL: ' + location.href);
        lines.push('Hash: ' + location.hash);
        lines.push('Title: ' + cleanText(document.title).slice(0, 100));
        lines.push('');
        var groups = {
            '回复列表容器(listSelectors)': DISCUSS.listSelectors,
            '楼层(itemSelectors)': DISCUSS.itemSelectors,
            '正文(contentSelectors)': DISCUSS.contentSelectors,
            '编辑器作用域(editorScope)': DISCUSS.editorScopeSelectors,
        };
        var i, key;
        for (key in groups) {
            var hits = collectCandidates(document, groups[key], 40);
            var vis = 0;
            for (i = 0; i < hits.length; i++) if (isVisible(hits[i])) vis++;
            lines.push(key + '：命中 ' + hits.length + '（可见 ' + vis + '）');
        }
        lines.push('');
        var dumpSels = {
            '回复/评论容器': '[class*="reply"], [class*="comment"], [class*="discuss"], [class*="post"], [class*="floor"]',
            '编辑器': 'textarea, [contenteditable], [class*="editor"], [class*="Editor"]',
            '点赞/投票': '[class*="vote"], [class*="like"], [class*="zan"], [class*="praise"], [class*="thumb"]',
            '按钮(回复/发表/发布/提交/发送)': 'button, a, [role="button"], input[type="submit"]',
            '单选项': 'input[type="radio"], input[type="checkbox"]',
        };
        var k2;
        for (k2 in dumpSels) {
            var els;
            try { els = document.querySelectorAll(dumpSels[k2]); } catch (e) { continue; }
            var shown = 0;
            for (i = 0; i < els.length && shown < 14; i++) {
                var el = els[i];
                if (!isVisible(el)) continue;
                if (k2.indexOf('按钮') !== -1) {
                    var tt = cleanText(el.textContent || el.value || '').slice(0, 6);
                    if (!/回复|发表|发布|提交|发送/.test(tt)) continue;
                }
                if (k2.indexOf('单选项') !== -1) {
                    var lbl = el.closest ? el.closest('label') : null;
                    var ltxt = lbl ? cleanText(lbl.textContent).slice(0, 24) : '';
                    lines.push('  [radio] ' + ltxt);
                    shown++;
                    continue;
                }
                var cls = typeof el.className === 'string' ? el.className : (el.getAttribute ? (el.getAttribute('class') || '') : '');
                var txt = cleanText(el.textContent || '').slice(0, 40);
                var idattr = el.id ? ' id="' + el.id + '"' : '';
                var extra = (el.disabled ? ' [disabled]' : '') + (el.readOnly ? ' [readonly]' : '');
                lines.push('  <' + String(el.tagName || '').toLowerCase() + ' class="' + cls.slice(0, 90) + '"' + idattr + extra + '> ' + txt);
                shown++;
            }
            if (shown > 0) { lines.push('（' + k2 + ' 可见候选 ' + shown + ' 条）'); lines.push(''); }
        }

        // 目录/侧栏结构诊断：自动学习的“下一内容”依赖侧栏链接与平台“下一个”按钮
        lines.push('【目录/侧栏】');
        var catSels = [
            '[class*="catalog"]', '[class*="chapter"]', '[class*="lesson"]', '[class*="menu"]',
            '[class*="sidebar"]', '[class*="mooc-catalog"]', '[class*="mooc-lesson"]', '[class*="mooc-chapter"]',
            '[class*="mooc-sidebar"]', '[class*="mooc-nav"]', '[class*="course-nav"]', '[class*="learn-nav"]',
            '[class*="learn-navigation"]', '[class*="learn-list"]', '[class*="learn-lesson"]', '[class*="learn-catalog"]',
        ];
        var catSeen = {};
        for (var ci = 0; ci < catSels.length; ci++) {
            var cel;
            try { cel = document.querySelectorAll(catSels[ci]); } catch (e) { continue; }
            for (var cj = 0; cj < cel.length && cj < 6; cj++) {
                var ce = cel[cj];
                if (!isVisible(ce) || catSeen[ce]) continue;
                catSeen[ce] = true;
                var ccls = typeof ce.className === 'string' ? ce.className : (ce.getAttribute ? (ce.getAttribute('class') || '') : '');
                var cown = '';
                if (ce.tagName === 'A') {
                    var coh = (ce.getAttribute && ce.getAttribute('href')) || '';
                    cown = ' href="' + coh.slice(0, 110) + '"';
                }
                lines.push('  [' + (cj + 1) + '] <' + String(ce.tagName || '').toLowerCase() + ' class="' + ccls.slice(0, 100) + '"' + cown + '> ' + cleanText((ce.textContent || '').slice(0, 16)));
                var aels = ce.querySelectorAll('a[href*="/content/"], a[href*="id="], [data-content-id], [data-id]');
                var shownA = 0;
                for (var ak = 0; ak < aels.length && shownA < 8; ak++) {
                    var ae = aels[ak];
                    var ah = (ae.getAttribute && ae.getAttribute('href')) || '';
                    var aid = (ae.getAttribute && (ae.getAttribute('data-content-id') || ae.getAttribute('data-id'))) || '';
                    var atxt = cleanText((ae.textContent || '').slice(0, 20));
                    if (!ah && !aid && !atxt) continue;
                    lines.push('      <a href="' + ah.slice(0, 110) + '" data="' + aid + '"> ' + atxt);
                    shownA++;
                }
            }
        }
        lines.push('【所有 learn-navigation / 本课程链接】');
        var allNav = document.querySelectorAll('a[class*="navigation"], a[class*="learn-nav"], a[href*="/mooc/learn/"], a[href*="/content/"]');
        var shownNav = 0;
        var navSeen = {};
        for (var nv = 0; nv < allNav.length && shownNav < 16; nv++) {
            var nav = allNav[nv];
            if (!isVisible(nav) || navSeen[nav]) continue;
            navSeen[nav] = true;
            var navcls = typeof nav.className === 'string' ? nav.className : (nav.getAttribute ? (nav.getAttribute('class') || '') : '');
            var navhref = (nav.getAttribute && nav.getAttribute('href')) || '';
            var navtxt = cleanText((nav.textContent || '').slice(0, 20));
            lines.push('  <a class="' + navcls.slice(0, 80) + '" href="' + navhref.slice(0, 120) + '"> ' + navtxt);
            shownNav++;
        }
        if (shownNav === 0) lines.push('  （页面里没有任何 /mooc/learn 或 /content 链接）');
        lines.push('【“下一个/下一节”入口】');
        var nextEls = document.querySelectorAll('a, button, [role="button"]');
        var shownN = 0;
        for (var nk = 0; nk < nextEls.length && shownN < 6; nk++) {
            var nel = nextEls[nk];
            if (!isVisible(nel)) continue;
            var nlabel = nel.getAttribute ? (nel.getAttribute('aria-label') || nel.getAttribute('title') || '') : '';
            var ntxt = cleanText((nel.textContent || '').slice(0, 8));
            if (!/下一个|下一节|下一讲|下一章|下一单元|下一课|下个|下页/.test(ntxt) && !/下一个|下一节|下一讲/.test(nlabel)) continue;
            var ncls2 = typeof nel.className === 'string' ? nel.className : (nel.getAttribute ? (nel.getAttribute('class') || '') : '');
            var nhref = (nel.getAttribute && nel.getAttribute('href')) || '';
            lines.push('  <' + String(nel.tagName || '').toLowerCase() + ' class="' + ncls2.slice(0, 80) + '" href="' + nhref.slice(0, 110) + '"> ' + ntxt);
            shownN++;
        }
        if (shownN === 0) lines.push('  （未找到“下一个”入口 —— 将退化为按内容 ID +1 导航）');
        lines.push('【章节标题候选】');
        var chs = document.querySelectorAll('[class*="titleBar"], [class*="crumb"], [class*="breadcrumb"], [class*="chapter-title"], [class*="catalog-title"], [class*="mooc-catalog"] h3, [class*="mooc-catalog"] h4, [class*="mooc-catalog"] [class*="title"], [class*="learn-title"], [class*="learn-chapter"], [class*="learn-lesson-title"], [class*="learn-navigation"] h3, [class*="learn-navigation"] h4, [class*="learn-navigation"] [class*="title"]');
        var shownT = 0;
        for (var tk = 0; tk < chs.length && shownT < 6; tk++) {
            var tel = chs[tk];
            var tt3 = cleanText((tel.textContent || '').slice(0, 30));
            if (!tt3) continue;
            var tcls3 = typeof tel.className === 'string' ? tel.className : (tel.getAttribute ? (tel.getAttribute('class') || '') : '');
            lines.push('  <' + String(tel.tagName || '').toLowerCase() + ' class="' + tcls3.slice(0, 80) + '"> ' + tt3);
            shownT++;
        }

        lines.push('【顶部章节/小节下拉按钮】');
        var ddBtns = document.querySelectorAll('header button[aria-expanded], [class*="header"] button[aria-expanded], nav button[aria-expanded], button[aria-expanded]');
        var shownD = 0;
        for (var dk = 0; dk < ddBtns.length && shownD < 8; dk++) {
            var db = ddBtns[dk];
            if (!isVisible(db)) continue;
            var dl = db.getAttribute('aria-label') || '';
            var dcls = typeof db.className === 'string' ? db.className : (db.getAttribute ? (db.getAttribute('class') || '') : '');
            var dexp = db.getAttribute('aria-expanded') || '';
            lines.push('  <button aria-expanded="' + dexp + '" aria-label="' + dl.slice(0, 40) + '" class="' + dcls.slice(0, 80) + '">');
            shownD++;
        }
        if (shownD === 0) lines.push('  （页面里没有找到带 aria-expanded 的下拉按钮）');
        lines.push('【内容标签栏 role=tablist】');
        var tablists = document.querySelectorAll('[role="tablist"]');
        var shownTab = 0;
        for (var tl = 0; tl < tablists.length && tl < 3; tl++) {
            var tbs = tablists[tl].querySelectorAll('[role="tab"]');
            for (var tb = 0; tb < tbs.length && shownTab < 24; tb++) {
                var lb = tbs[tb].getAttribute('aria-label') || '';
                var sel = tbs[tb].getAttribute('aria-selected') || '';
                lines.push('  <tab aria-selected="' + sel + '" aria-label="' + lb.slice(0, 40) + '"> ' + cleanText((tbs[tb].textContent || '').slice(0, 20)));
                shownTab++;
            }
        }
        if (tablists.length === 0) lines.push('  （页面里没有 role=tablist 标签栏）');

        lines.push('—— 把以上内容完整复制并发给作者，即可精准适配新版 UI ——');
        showTextOverlay('页面 DOM 诊断（请复制全部内容）', lines.join('\n'));
        updateStatus('🔎 已生成页面 DOM 诊断，浮层里可直接复制');
    }

    // ===================== 初始化 =====================
    function init() {
        // 恢复上次的复制开关状态（页面刷新后不用再点一次）
        applyCopyUnlock(isCopyUnlockOn());
        createFloatingPanel();
        // 悬浮【下一节】按钮（自动学习运行时显示）
        createFloatNextBtn();
        // 新版路径路由整页刷新后，接着跑上次未完成的自动学习
        resumeLearn();
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 1000);
    } else {
        window.addEventListener('load', function () { setTimeout(init, 1000); });
    }
})();
