// Blog search: filters the server-rendered post list. search.json is fetched
// once, on first focus or input; without JS the full list stays visible.
(function () {
    'use strict';
    var form = document.querySelector('[data-blog-search]');
    var list = document.querySelector('[data-blog-list]');
    if (!form || !list || !window.fetch) return;
    var input = form.querySelector('input');
    var status = form.querySelector('[data-blog-search-status]');
    var cards = Array.prototype.slice.call(list.querySelectorAll('[data-url]'));
    var index = null;
    var loading = null;

    form.hidden = false;

    function load() {
        if (!loading) {
            loading = fetch(input.getAttribute('data-search-url'), { cache: 'no-cache' })
                .then(function (res) { return res.ok ? res.json() : []; })
                .then(function (data) {
                    index = {};
                    (Array.isArray(data) ? data : []).forEach(function (p) {
                        if (!p || typeof p.url !== 'string') return;
                        index[p.url] = [p.title, p.description, (p.tags || []).join(' '), p.text]
                            .filter(function (s) { return typeof s === 'string'; })
                            .join(' ').toLowerCase();
                    });
                })
                .catch(function () { index = {}; });
        }
        return loading;
    }

    // Fallback text when the index is missing a post: the card's own visible text.
    function haystack(card) {
        var url = card.getAttribute('data-url');
        return (index && index[url]) || card.textContent.toLowerCase();
    }

    function apply() {
        var terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
        var shown = 0;
        cards.forEach(function (card) {
            var text = haystack(card);
            var match = terms.every(function (t) { return text.indexOf(t) !== -1; });
            card.hidden = !match;
            if (match) shown++;
        });
        if (!terms.length) status.textContent = '';
        else if (!shown) status.textContent = 'No posts match "' + input.value.trim() + '".';
        else status.textContent = shown + (shown === 1 ? ' post matches.' : ' posts match.');
    }

    input.addEventListener('focus', load, { once: true });
    input.addEventListener('input', function () { load().then(apply); });
})();
