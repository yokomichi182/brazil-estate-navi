document.addEventListener('DOMContentLoaded', () => {
    const resultsGrid = document.getElementById('resultsGrid');
    const langSelect = document.getElementById('langSelect');
    const catTabs = document.querySelectorAll('.cat-tab');
    const resultTitle = document.getElementById('resultTitle');
    const sortSelect = document.getElementById('sortSelect');
    const searchInput = document.getElementById('searchInput');
    
    let currentLang = 'ja';
    let currentCategory = 'all';
    let map = null;
    let markersLayer = null;
    let currentMarkers = []; // To keep track of markers for bound filtering
    
    // City fallback coordinates
    const CITY_COORDS = {
        'paraibuna': { lat: -23.385, lng: -45.662 },
        'caraguatatuba': { lat: -23.622, lng: -45.414 },
        'sao-luiz-do-paraitinga': { lat: -23.222, lng: -45.310 },
        'jambeiro': { lat: -23.254, lng: -45.690 },
        'default': { lat: -23.385, lng: -45.662 }
    };

    // Exchange rates from BRL. Defaults are fallbacks; replaced by live rates on load.
    let RATES = { 'ja': 28.0, 'en': 0.20, 'pt': 1.0 };

    // Fetch live BRL exchange rates (frankfurter.app: free, no key, CORS-enabled).
    // Falls back silently to the hardcoded values if the request fails.
    async function loadExchangeRates() {
        try {
            const res = await fetch('https://api.frankfurter.dev/v1/latest?base=BRL&symbols=JPY,USD');
            if (!res.ok) throw new Error('rate fetch failed: ' + res.status);
            const json = await res.json();
            const r = json.rates || {};
            if (r.JPY) RATES.ja = r.JPY;
            if (r.USD) RATES.en = r.USD;
            console.info('Live exchange rates loaded:', RATES);
            // Re-render so prices reflect the live rates.
            if (typeof renderCardsAndMap === 'function') renderCardsAndMap();
        } catch (e) {
            console.warn('Using fallback exchange rates:', e.message);
        }
    }

    if (typeof propertiesData === 'undefined') {
        resultsGrid.innerHTML = '<p style="padding: 2rem; color: red;">データが見つかりません。scraper.pyを実行して data/data.js を生成してください。</p>';
        return;
    }

    function initMap() {
        map = L.map('map').setView([CITY_COORDS['default'].lat, CITY_COORDS['default'].lng], 10);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(map);
        markersLayer = L.layerGroup().addTo(map);

        // Update visible cards when map moves
        map.on('moveend', updateVisibleCards);
    }

    function parsePrice(priceStr) {
        if (!priceStr || priceStr === "R$ -") return null;
        const numericStr = priceStr.replace(/[R$\s\.]/g, '').replace(',', '.');
        return parseFloat(numericStr);
    }

    function getLocalizedPrice(priceStr, lang) {
        const val = parsePrice(priceStr);
        if (val === null) return lang === 'ja' ? '価格未定' : (lang === 'en' ? 'Price upon request' : 'Sob Consulta');
        
        const converted = val * RATES[lang];
        if (lang === 'ja') return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(converted);
        if (lang === 'en') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(converted);
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(converted);
    }
    
    function getCityFromUrl(url) {
        if (!url) return 'default';
        const u = url.toLowerCase();
        if (u.includes('caraguatatuba')) return 'caraguatatuba';
        if (u.includes('sao-luiz-do-paraitinga')) return 'sao-luiz-do-paraitinga';
        if (u.includes('jambeiro')) return 'jambeiro';
        if (u.includes('paraibuna')) return 'paraibuna';
        return 'default';
    }

    // Stable coordinates: real coords if present, otherwise a deterministic
    // offset derived from the listing URL so pins/cards don't jump on re-render.
    function getStableCoords(item) {
        if (item.lat && item.lng) return { lat: item.lat, lng: item.lng };
        if (item._coords) return item._coords;
        const base = CITY_COORDS[getCityFromUrl(item.url)];
        const seed = item.url || (item.title && item.title.pt) || 'x';
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
        const off1 = ((h % 1000) / 1000 - 0.5) * 0.05;
        const off2 = ((Math.floor(h / 1000) % 1000) / 1000 - 0.5) * 0.05;
        item._coords = { lat: base.lat + off1, lng: base.lng + off2 };
        return item._coords;
    }

    const minPriceInput = document.getElementById('minPrice');
    const maxPriceInput = document.getElementById('maxPrice');
    const bedFilterInput = document.getElementById('bedFilter');
    const applyFiltersBtn = document.getElementById('applyFiltersBtn');

    function renderCardsAndMap() {
        resultsGrid.innerHTML = '';
        markersLayer.clearLayers();
        currentMarkers = [];
        
        const minP = minPriceInput.value ? parseFloat(minPriceInput.value) : 0;
        const maxP = maxPriceInput.value ? parseFloat(maxPriceInput.value) : Infinity;
        const bedF = bedFilterInput.value === 'any' ? 0 : parseInt(bedFilterInput.value);
        const keyword = (searchInput.value || '').trim().toLowerCase();

        const filteredData = propertiesData.filter(item => {
            // Category filter
            if (currentCategory !== 'all' && item.category !== currentCategory) return false;

            // Bedroom filter
            let itemBeds = parseInt(item.bedrooms);
            if (isNaN(itemBeds)) itemBeds = 0;
            if (bedF > 0 && itemBeds < bedF) return false;

            // Price filter (convert property price to current currency to match user input)
            const rawVal = parsePrice(item.price);
            if (rawVal !== null) {
                const convertedVal = rawVal * RATES[currentLang];
                if (convertedVal < minP || convertedVal > maxP) return false;
            } else {
                // If price is unknown, only include if user didn't specify strict price bounds
                if (minP > 0 || maxP < Infinity) return false;
            }

            // Keyword search (title in all languages, description, and url)
            if (keyword) {
                const t = item.title || {};
                const d = item.description || {};
                const haystack = [
                    t.pt, t.en, t.ja, d.pt, d.en, d.ja, item.url
                ].filter(Boolean).join(' ').toLowerCase();
                if (!haystack.includes(keyword)) return false;
            }

            return true;
        });

        // Sort
        const sortBy = sortSelect ? sortSelect.value : 'relevance';
        if (sortBy === 'price-asc' || sortBy === 'price-desc') {
            filteredData.sort((a, b) => {
                const pa = parsePrice(a.price);
                const pb = parsePrice(b.price);
                // Items without a price always go last
                if (pa === null && pb === null) return 0;
                if (pa === null) return 1;
                if (pb === null) return -1;
                return sortBy === 'price-asc' ? pa - pb : pb - pa;
            });
        }

        if (filteredData.length === 0) {
            resultsGrid.innerHTML = '<p style="padding: 2rem;">この条件に一致する物件が見つかりませんでした。</p>';
            return;
        }

        const bounds = [];

        filteredData.forEach((item, index) => {
            const imgUrl = item.image_url || `https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&q=80&w=800&h=600&sig=${index}`;
            const displayPrice = getLocalizedPrice(item.price, currentLang);
            const title = item.title[currentLang] || item.title['pt'] || "物件名なし";
            
            let categoryText = "その他";
            if (currentLang === 'ja') {
                categoryText = item.category === 'rent' ? '賃貸' : (item.category === 'buy-apt' ? 'マンション' : '一戸建て');
            } else if (currentLang === 'en') {
                categoryText = item.category === 'rent' ? 'Rent' : (item.category === 'buy-apt' ? 'Condo' : 'House');
            } else {
                categoryText = item.category === 'rent' ? 'Aluguel' : (item.category === 'buy-apt' ? 'Apartamento' : 'Casa');
            }

            const source = item.source || 'ZAP';
            let sourceClass = 'badge-zap';
            let sourceLabel = 'ZAP Imóveis';
            
            if (source.toLowerCase() === 'vivareal') {
                sourceClass = 'badge-vivareal';
                sourceLabel = 'Viva Real';
            } else if (source.toLowerCase() === 'olx') {
                sourceClass = 'badge-olx';
                sourceLabel = 'OLX Brasil';
            } else if (source.toLowerCase() === 'imovelweb') {
                sourceClass = 'badge-imovelweb';
                sourceLabel = 'Imovelweb';
            }

            const card = document.createElement('a');
            card.href = item.url;
            card.target = "_blank";
            card.className = 'card';
            card.id = `card-${index}`;
            
            card.innerHTML = `
                <div class="badge-source ${sourceClass}">${sourceLabel}</div>
                <img src="${imgUrl}" alt="Imóvel" class="card-image" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&q=80&w=800&h=600'">
                <div class="card-content">
                    <div class="card-title">${title}</div>
                    <div class="card-price">${displayPrice}</div>
                    <table class="card-info-table">
                        <tr>
                            <th>間取り</th><td>${item.bedrooms}</td>
                            <th>面積</th><td>${item.area}</td>
                        </tr>
                        <tr>
                            <th>バス</th><td>${item.bathrooms}</td>
                            <th>種別</th><td><span style="background: #fdf2e9; color: #f26522; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem;">${categoryText}</span></td>
                        </tr>
                    </table>
                </div>
            `;
            resultsGrid.appendChild(card);

            // Coordinates Logic (stable across re-renders)
            const coords = getStableCoords(item);
            const lat = coords.lat;
            const lng = coords.lng;

            bounds.push([lat, lng]);
            const marker = L.marker([lat, lng]).addTo(markersLayer);
            
            const popupContent = `
                <div class="leaflet-popup-content-inner">
                    <img src="${imgUrl}" class="popup-img">
                    <div class="popup-info">
                        <div class="popup-price">${displayPrice}</div>
                        <div class="popup-title">${title}</div>
                    </div>
                </div>
            `;
            marker.bindPopup(popupContent);
            
            currentMarkers.push({
                index: index,
                marker: marker,
                card: card,
                lat: lat,
                lng: lng
            });
        });

        if (bounds.length > 0 && map) {
            map.fitBounds(bounds, { padding: [30, 30] });
            setTimeout(updateVisibleCards, 300); // Initial filter after bound calculation
        }
    }

    function updateVisibleCards() {
        if (!map) return;
        const bounds = map.getBounds();
        let visibleCount = 0;
        
        currentMarkers.forEach(item => {
            const latLng = L.latLng(item.lat, item.lng);
            if (bounds.contains(latLng)) {
                item.card.style.display = 'flex';
                visibleCount++;
            } else {
                item.card.style.display = 'none';
            }
        });
        
        if (currentLang === 'ja') {
            resultTitle.textContent = `マップ上の物件 (${visibleCount}件)`;
        } else if (currentLang === 'en') {
            resultTitle.textContent = `Properties on Map (${visibleCount})`;
        } else {
            resultTitle.textContent = `Imóveis no Mapa (${visibleCount})`;
        }
    }

    catTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            catTabs.forEach(t => t.classList.remove('active'));
            e.currentTarget.classList.add('active');
            currentCategory = e.currentTarget.getAttribute('data-cat');
            renderCardsAndMap();
        });
    });

    langSelect.addEventListener('change', (e) => {
        currentLang = e.target.value;
        renderCardsAndMap();
    });
    
    applyFiltersBtn.addEventListener('click', () => {
        renderCardsAndMap();
    });

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            renderCardsAndMap();
        });
    }

    // Search: filter on Enter or after the user stops typing
    if (searchInput) {
        let searchTimer = null;
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                renderCardsAndMap();
            }
        });
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(renderCardsAndMap, 300);
        });
    }

    // Honor ?lang= for shareable, language-specific links (matches hreflang tags).
    const urlLang = new URLSearchParams(location.search).get('lang');
    if (urlLang && ['ja', 'en', 'pt'].includes(urlLang)) {
        currentLang = urlLang;
        if (langSelect) langSelect.value = urlLang;
    }

    initMap();
    renderCardsAndMap();
    loadExchangeRates();
});
