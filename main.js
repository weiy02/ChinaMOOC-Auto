// ==UserScript==
// @name         中国大学MOOC-学生互评自动化
// @namespace    https://github.com/weiy02/-
// @version      1.7
// @description  中国大学MOOC学生互评自动化：解析真实分值选最高分，评语“科技改变生活”，答题者不可见。支持停止、评分修复。
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
        updateStatus('正在评分当前作业...');
        var r = await rateCurrentAssignment();
        if (!r.success) { updateStatus('评分失败：' + r.error); return; }
        updateStatus('正在提交...');
        var s = await submitCurrent();
        if (!s.success) { updateStatus('提交失败：' + s.error); return; }
        updateStatus('当前作业互评完成 ✓');
    }

    async function batchReview(count) {
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

    // ===================== 状态栏 & 按钮 =====================
    var statusEl = null;
    function updateStatus(msg) {
        if (statusEl) statusEl.textContent = msg;
        console.log('[MOOC互评]', msg);
    }

    function setButtonsRunning(isRunning) {
        var ids = ['mar-one', 'mar-batch', 'mar-auto', 'mar-fix', 'mar-stop'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (!el) continue;
            el.disabled = (ids[i] === 'mar-stop') ? !isRunning : isRunning;
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
            '#mar-body { padding: 12px 12px 13px; display: flex; flex-direction: column; gap: 7px; }',
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
            '#mar-status {',
            '  margin-top: 5px; padding: 9px 11px; border-radius: 10px;',
            '  background: rgba(255, 255, 255, 0.3);',
            '  border: 1px solid rgba(255, 255, 255, 0.55);',
            '  box-shadow: inset 0 1px 2px rgba(15, 20, 40, 0.04), inset 0 -1px 0 rgba(255, 255, 255, 0.6);',
            '  font-size: 11.5px; line-height: 1.5; color: #3a3a3c;',
            '  min-height: 16px; word-break: break-all;',
            '  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);',
            '}',
        ].join('\n');
        document.head.appendChild(style);
    }

    // ===================== 悬浮窗 UI =====================
    function createFloatingPanel() {
        if (document.getElementById('mooc-auto-review-panel')) return;
        injectStyles();

        var panel = document.createElement('div');
        panel.id = 'mooc-auto-review-panel';
        panel.innerHTML = [
            '<div id="mar-header">',
            '  <span id="mar-title"><span class="mar-dot"></span>MOOC 互评助手</span>',
            '  <span id="mar-minimize" title="最小化">−</span>',
            '</div>',
            '<div id="mar-body">',
            '  <button id="mar-one" class="mar-btn">一键互评（当前 1 份）</button>',
            '  <button id="mar-batch" class="mar-btn">快速互评（连续 10 份）</button>',
            '  <button id="mar-auto" class="mar-btn">全自动互评（直到完成）</button>',
            '  <button id="mar-fix" class="mar-btn">评分修复（列表检测）</button>',
            '  <button id="mar-stop" class="mar-btn" disabled>停止当前操作</button>',
            '  <div id="mar-status">就绪</div>',
            '</div>'
        ].join('');
        document.body.appendChild(panel);

        statusEl = document.getElementById('mar-status');

        var minimized = false;
        var bodyEl = document.getElementById('mar-body');
        document.getElementById('mar-minimize').addEventListener('click', function () {
            minimized = !minimized;
            bodyEl.style.display = minimized ? 'none' : 'flex';
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
        document.getElementById('mar-stop').addEventListener('click', function () {
            if (!taskState.running) return;
            taskState.cancelled = true;
            updateStatus('⏹ 正在停止...');
        });
    }

    // ===================== 初始化 =====================
    function init() { createFloatingPanel(); }
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(init, 1000);
    } else {
        window.addEventListener('load', function () { setTimeout(init, 1000); });
    }
})();
