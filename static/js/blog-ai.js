(function () {
    const root = document.querySelector("[data-blog-ai]");
    if (!root) return;

    const trigger = root.querySelector(".blog-ai__trigger");
    const panel = root.querySelector(".blog-ai__panel");
    const closeButton = root.querySelector(".blog-ai__close");
    const form = root.querySelector(".blog-ai__form");
    const input = root.querySelector(".blog-ai__input");
    const messages = root.querySelector(".blog-ai__messages");
    const config = {
        endpoint: root.dataset.endpoint || "/api/blog-ai",
        searchIndex: root.dataset.searchIndex || "/search/index.json",
        contextLimit: Number(root.dataset.contextLimit || 6),
    };
    let indexPromise = null;
    let busy = false;

    function openPanel() {
        panel.hidden = false;
        root.classList.add("blog-ai--open");
        input.focus();
    }

    function closePanel() {
        panel.hidden = true;
        root.classList.remove("blog-ai--open");
        trigger.focus();
    }

    function addMessage(role, text) {
        const item = document.createElement("div");
        item.className = `blog-ai__message blog-ai__message--${role}`;
        item.textContent = text;
        messages.appendChild(item);
        messages.scrollTop = messages.scrollHeight;
        return item;
    }

    function addSources(contexts) {
        if (!contexts.length) return;
        const list = document.createElement("div");
        list.className = "blog-ai__sources";

        const title = document.createElement("span");
        title.textContent = "参考";
        list.appendChild(title);

        contexts.slice(0, 4).forEach((item) => {
            const link = document.createElement("a");
            const label = item.section === "reference" ? "速查" : "文章";
            link.href = item.permalink;
            link.textContent = `${label}: ${item.title || item.permalink}`;
            link.target = "_blank";
            link.rel = "noopener";
            list.appendChild(link);
        });

        messages.appendChild(list);
        messages.scrollTop = messages.scrollHeight;
    }

    async function loadIndex() {
        if (!indexPromise) {
            indexPromise = fetch(config.searchIndex, { credentials: "same-origin" })
                .then((response) => {
                    if (!response.ok) throw new Error("无法读取博客索引");
                    return response.json();
                });
        }

        return indexPromise;
    }

    function tokenize(text) {
        const value = String(text || "").toLowerCase();
        const words = value.match(/[a-z0-9_+#.-]{2,}/g) || [];
        const cjkPhrases = value.match(/[\u4e00-\u9fff]{2,}/g) || [];
        const cjkTokens = [];

        cjkPhrases.forEach((phrase) => {
            cjkTokens.push(phrase);
            for (let i = 0; i < phrase.length - 1; i += 1) {
                cjkTokens.push(phrase.slice(i, i + 2));
            }
        });

        return Array.from(new Set(words.concat(cjkTokens))).slice(0, 24);
    }

    function countMatches(text, token) {
        let count = 0;
        let position = text.indexOf(token);

        while (position !== -1 && count < 12) {
            count += 1;
            position = text.indexOf(token, position + token.length);
        }

        return count;
    }

    function makeSnippet(content, tokens) {
        const text = String(content || "").replace(/\s+/g, " ").trim();
        if (!text) return "";

        const lower = text.toLowerCase();
        const token = tokens.find((item) => lower.includes(item));
        const center = token ? lower.indexOf(token) : 0;
        const start = Math.max(0, center - 260);
        const end = Math.min(text.length, start + 920);
        const prefix = start > 0 ? "..." : "";
        const suffix = end < text.length ? "..." : "";

        return `${prefix}${text.slice(start, end)}${suffix}`;
    }

    function pickContexts(question, pages) {
        const tokens = tokenize(question);
        const limit = Number(config.contextLimit || 6);
        const questionText = String(question || "").toLowerCase();

        return pages
            .map((page) => {
                const title = String(page.title || "");
                const content = String(page.content || "");
                const section = String(page.section || "");
                const haystack = `${title}\n${content}`.toLowerCase();
                const titleText = title.toLowerCase();

                const baseScore = tokens.reduce((sum, token) => {
                    const titleScore = titleText.includes(token) ? 10 : 0;
                    return sum + titleScore + countMatches(haystack, token);
                }, 0);
                const exactTitleScore = titleText && questionText.includes(titleText) ? 24 : 0;
                const referenceBoost = section === "reference" && baseScore > 0 ? 14 : 0;
                const score = baseScore + exactTitleScore + referenceBoost;

                return {
                    title,
                    permalink: page.permalink,
                    date: page.date,
                    section,
                    snippet: makeSnippet(content, tokens),
                    score,
                };
            })
            .filter((page) => page.score > 0 && page.snippet)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    async function ask(question) {
        const pages = await loadIndex();
        const contexts = pickContexts(question, Array.isArray(pages) ? pages : []);

        const response = await fetch(config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question, contexts }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || "AI 服务暂时不可用");
        }

        return { answer: data.answer, contexts };
    }

    trigger.addEventListener("click", () => {
        if (panel.hidden) openPanel();
        else closePanel();
    });

    closeButton.addEventListener("click", closePanel);

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !panel.hidden) closePanel();
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const question = input.value.trim();
        if (!question || busy) return;

        busy = true;
        form.classList.add("blog-ai__form--busy");
        input.value = "";
        addMessage("user", question);
        const pending = addMessage("assistant", "正在检索博客内容...");

        try {
            const result = await ask(question);
            pending.textContent = result.answer || "我没有得到可用回答。";
            addSources(result.contexts);
        } catch (error) {
            pending.textContent = error.message || "AI 服务暂时不可用。";
        } finally {
            busy = false;
            form.classList.remove("blog-ai__form--busy");
            input.focus();
        }
    });
})();
