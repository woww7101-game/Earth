const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const S = {
    token: localStorage.getItem('terraweather-token') || '',
    user: null,
    auth: 'register',
    viewer: null,
    heat: false,
    selected: null,
    hoverTimer: null,
    lastHover: 0,
    saved: [],
    config: null,
    pcPointer: matchMedia('(hover:hover) and (pointer:fine)').matches
};

const api = async (url, opt = {}) => {
    const headers = {
        'Content-Type': 'application/json',
        ...(opt.headers || {})
    };

    if (S.token) headers.Authorization = 'Bearer ' + S.token;

    const r = await fetch(url, { ...opt, headers });
    const d = await r.json().catch(() => ({
        detail: 'Сервер вернул неожиданный ответ'
    }));

    if (!r.ok) throw Error(d.detail || 'Ошибка запроса');
    return d;
};

function toast(t) {
    const e = $('#toast');
    e.textContent = t;
    e.classList.add('show');
    clearTimeout(e._timer);
    e._timer = setTimeout(() => e.classList.remove('show'), 2800);
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function localTime(epoch, offset) {
    return new Date((epoch + (offset || 0)) * 1000)
        .toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'UTC'
        });
}

function dateLabel(epoch, offset) {
    return new Date((epoch + (offset || 0)) * 1000)
        .toLocaleDateString('ru-RU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC'
        });
}

/* =========================
   АВТОРИЗАЦИЯ
========================= */

function setAuth(mode) {
    S.auth = mode;

    $$('[data-auth]').forEach(b =>
        b.classList.toggle('selected', b.dataset.auth === mode)
    );

    const reg = mode === 'register';

    $('#authTitle').textContent = reg
        ? 'Создай свой аккаунт'
        : 'С возвращением';

    $('#usernameWrap').classList.toggle('hidden', !reg);
    $('#emailWrap').classList.toggle('hidden', !reg);

    $('#username').required = reg;
    $('#email').required = reg;

    $('#password').autocomplete = reg
        ? 'new-password'
        : 'current-password';

    $('#email').type = reg ? 'email' : 'text';

    $('#email').placeholder = reg
        ? 'you@example.com'
        : 'Email или имя пользователя';

    $('#authSubmit').textContent = reg
        ? 'Создать аккаунт'
        : 'Войти';

    $('#authError').textContent = '';
}

$$('[data-auth]').forEach(b => {
    b.onclick = () => setAuth(b.dataset.auth);
});

$('#authForm').onsubmit = async e => {
    e.preventDefault();

    $('#authSubmit').disabled = true;
    $('#authError').textContent = '';

    try {
        const body = S.auth === 'register'
            ? {
                username: $('#username').value.trim(),
                email: $('#email').value.trim(),
                password: $('#password').value
            }
            : {
                login: $('#email').value.trim(),
                password: $('#password').value
            };

        const d = await api('/api/' + S.auth, {
            method: 'POST',
            body: JSON.stringify(body)
        });

        S.token = d.token;
        S.user = d.user;

        localStorage.setItem('terraweather-token', S.token);

        await enterApp();

    } catch (err) {
        $('#authError').textContent = err.message;

    } finally {
        $('#authSubmit').disabled = false;
    }
};

$('#logout').onclick = () => {
    localStorage.removeItem('terraweather-token');
    location.reload();
};

/* =========================
   ЗАПУСК ПРИЛОЖЕНИЯ
========================= */

async function enterApp() {
    try {
        if (!S.user) {
            const d = await api('/api/me');
            S.user = d.user;
        }

        $('#authScreen').classList.add('hidden');
        $('#app').classList.remove('hidden');

        $('#userName').textContent = S.user.username;
        $('#userEmail').textContent = S.user.email;

        $('#userAvatar').textContent =
            (S.user.username || 'T')[0].toUpperCase();

        await Promise.all([
            loadConfig(),
            loadSaved()
        ]);

        initGlobe();

    } catch (e) {
        if (S.token) {
            localStorage.removeItem('terraweather-token');
            S.token = '';
        }

        $('#authScreen').classList.remove('hidden');
        $('#app').classList.add('hidden');

        if (e.message !== 'Войди в аккаунт') {
            toast(e.message);
        }
    }
}

async function loadConfig() {
    try {
        S.config = await api('/api/config');

        $('#statusText').textContent =
            S.config.database_configured
                ? 'Сервисы готовы'
                : 'База данных не подключена';

        if (!S.config.cesium_token) {
            toast(
                'Добавь CESIUM_ION_TOKEN в Render, чтобы включить рельеф Cesium ion.'
            );
        }

    } catch (e) {
        $('#statusText').textContent = 'Часть сервисов недоступна';
    }
}

/* =========================
   НАВИГАЦИЯ
========================= */

function showView(name) {
    $$('.view').forEach(v => v.classList.add('hidden'));

    const ids = {
        earth: '#earthView',
        weather: '#weatherView',
        assistant: '#assistantView'
    };

    $(ids[name] || ids.earth).classList.remove('hidden');

    $$('.nav').forEach(b =>
        b.classList.toggle('active', b.dataset.view === name)
    );

    const titles = {
        earth: ['LIVE GLOBE / 01', 'Объёмная Земля'],
        weather: ['WEATHER DESTINATIONS / 02', 'Погода и места'],
        assistant: ['GROQ INTELLIGENCE / 03', 'ИИ-помощник']
    };

    $('#sectionEyebrow').textContent = titles[name][0];
    $('#sectionTitle').textContent = titles[name][1];

    $('#sidebar').classList.remove('open');

    if (name === 'earth' && S.viewer) {
        setTimeout(() => S.viewer.resize(), 80);
    }
}

$$('.nav').forEach(b => {
    b.onclick = () => showView(b.dataset.view);
});

$('#menuBtn').onclick = () =>
    $('#sidebar').classList.toggle('open');

/* =========================
   ИНИЦИАЛИЗАЦИЯ CESIUM
========================= */

function createSatelliteLayer() {
    return new Cesium.UrlTemplateImageryProvider({
        url:
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        maximumLevel: 19,
        credit: 'Esri World Imagery'
    });
}

function initGlobe() {
    if (!window.Cesium) {
        toast('CesiumJS не загрузился');
        return;
    }

    if (S.viewer) {
        S.viewer.resize();
        return;
    }

    if (S.config?.cesium_token) {
        Cesium.Ion.defaultAccessToken = S.config.cesium_token;
    }

    try {
        S.viewer = new Cesium.Viewer('cesiumContainer', {
            animation: false,
            timeline: false,
            baseLayerPicker: false,
            geocoder: false,
            homeButton: true,
            sceneModePicker: false,
            navigationHelpButton: false,
            infoBox: false,
            selectionIndicator: false,
            fullscreenButton: false,
            shouldAnimate: true
        });

        S.viewer.scene.globe.enableLighting = true;
        S.viewer.scene.globe.depthTestAgainstTerrain = true;

        /*
         * ИСПРАВЛЕНИЕ:
         * Удаляем стандартные слои Cesium и устанавливаем
         * спутниковую подложку через UrlTemplateImageryProvider.
         */
        S.viewer.imageryLayers.removeAll();

        S.viewer.imageryLayers.addImageryProvider(
            createSatelliteLayer()
        );

        /*
         * Реальный 3D-рельеф Cesium ion.
         */
        if (S.config?.cesium_token) {
            Cesium.CesiumTerrainProvider
                .fromIonAssetId(1)
                .then(provider => {
                    if (S.viewer) {
                        S.viewer.terrainProvider = provider;
                    }
                })
                .catch(() => {
                    toast(
                        'Рельеф Cesium ion недоступен для этого токена'
                    );
                });
        }

        /*
         * Начальный вид Земли.
         */
        S.viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(
                20,
                25,
                18500000
            )
        });

        /*
         * Нажатие на Землю показывает погоду.
         */
        S.viewer.screenSpaceEventHandler.setInputAction(
            click => {
                const c = S.viewer.camera.pickEllipsoid(
                    click.position,
                    S.viewer.scene.globe.ellipsoid
                );

                if (!c) return;

                const p = Cesium.Cartographic.fromCartesian(c);

                const lat = Cesium.Math.toDegrees(p.latitude);
                const lon = Cesium.Math.toDegrees(p.longitude);

                selectCoordinates(lat, lon, click.position);
            },
            Cesium.ScreenSpaceEventType.LEFT_CLICK
        );

        /*
         * Наведение курсора на компьютере.
         */
        S.viewer.canvas.addEventListener('mousemove', e => {
            if (!S.pcPointer) return;

            const now = Date.now();

            if (now - S.lastHover < 800) return;
            S.lastHover = now;

            const rect = S.viewer.canvas.getBoundingClientRect();

            const pos = new Cesium.Cartesian2(
                e.clientX - rect.left,
                e.clientY - rect.top
            );

            const c = S.viewer.camera.pickEllipsoid(
                pos,
                S.viewer.scene.globe.ellipsoid
            );

            if (!c) return;

            const p = Cesium.Cartographic.fromCartesian(c);

            const lat = Cesium.Math.toDegrees(p.latitude);
            const lon = Cesium.Math.toDegrees(p.longitude);

            $('#coords').textContent =
                `LAT ${lat.toFixed(3)} / LON ${lon.toFixed(3)}`;

            clearTimeout(S.hoverTimer);

            S.hoverTimer = setTimeout(() => {
                fetchWeather(lat, lon, {
                    hover: true,
                    screenX: e.clientX,
                    screenY: e.clientY
                });
            }, 550);
        });

        S.viewer.canvas.addEventListener('mouseleave', () => {
            clearTimeout(S.hoverTimer);

            if (S.pcPointer) {
                $('#weatherPopup').classList.add('hidden');
            }
        });

        window.addEventListener('resize', () => {
            S.viewer?.resize();
        });

    } catch (e) {
        toast('Ошибка создания глобуса: ' + e.message);
    }
}

/* =========================
   ПЕРЕКЛЮЧЕНИЕ СЛОЁВ
========================= */

$('#globeMode').onclick = () => setMapMode(false);
$('#heatMode').onclick = () => setMapMode(true);

function setMapMode(heat) {
    S.heat = heat;

    $('#globeMode').classList.toggle('active', !heat);
    $('#heatMode').classList.toggle('active', heat);

    if (!S.viewer) return;

    /*
     * Сначала очищаем слои.
     * Затем добавляем корректный спутниковый слой.
     */
    S.viewer.imageryLayers.removeAll();

    S.viewer.imageryLayers.addImageryProvider(
        createSatelliteLayer()
    );

    /*
     * Температурная карта OpenWeather.
     */
    if (heat) {
        S.viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
                url: '/api/tiles/{z}/{x}/{y}.png',
                tilingScheme: new Cesium.WebMercatorTilingScheme(),
                maximumLevel: 8,
                credit: 'OpenWeather'
            })
        );

        toast('Включён температурный слой OpenWeather');

    } else {
        toast('Реальная спутниковая поверхность включена');
    }
}

/* =========================
   ПОГОДА ПРИ НАЖАТИИ
========================= */

let popupCoords = null;

async function selectCoordinates(lat, lon, screenPos) {
    S.selected = {
        lat,
        lon,
        name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    };

    popupCoords = { lat, lon };

    $('#coords').textContent =
        `LAT ${lat.toFixed(3)} / LON ${lon.toFixed(3)}`;

    if (S.viewer) {
        S.viewer.entities.removeById('selected-weather-point');

        S.viewer.entities.add({
            id: 'selected-weather-point',

            position: Cesium.Cartesian3.fromDegrees(lon, lat),

            point: {
                pixelSize: 10,
                color: Cesium.Color.fromCssColorString('#74e3c2'),
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2
            }
        });
    }

    $('#weatherPopup').classList.remove('hidden');

    if (screenPos) {
        const rect = $('#cesiumContainer').getBoundingClientRect();

        let left = Math.min(
            Math.max(12, screenPos.x - rect.left + 14),
            rect.width - 315
        );

        let top = Math.min(
            Math.max(62, screenPos.y - rect.top - 80),
            rect.height - 275
        );

        if (window.innerWidth <= 760) {
            left = 10;
            top = rect.height - 285;
        }

        $('#weatherPopup').style.left = left + 'px';
        $('#weatherPopup').style.top = top + 'px';
        $('#weatherPopup').style.right = 'auto';
    }

    await fetchWeather(lat, lon);
}

$('#closePopup').onclick = () => {
    $('#weatherPopup').classList.add('hidden');
};

$('#openDetails').onclick = () => {
    if (!S.selected) return;

    showView('weather');

    loadPlace(
        S.selected.name,
        S.selected.lat,
        S.selected.lon
    );
};

/* =========================
   ЗАПРОС ПОГОДЫ
========================= */

async function fetchWeather(
    lat,
    lon,
    { hover = false, screenX, screenY } = {}
) {
    try {
        const d = await api(
            `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
        );

        if (hover && !S.pcPointer) return;

        $('#popupPlace').textContent =
            d.name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;

        $('#popupTemp').textContent = d.temp + '°';
        $('#popupDesc').textContent = d.description;

        $('#popupIcon').src =
            `https://openweathermap.org/img/wn/${d.icon}@2x.png`;

        $('#popupHumidity').textContent =
            `Влажность ${d.humidity}%`;

        $('#popupWind').textContent =
            `Ветер ${d.wind} м/с`;

        if (hover) {
            $('#weatherPopup').classList.remove('hidden');

            const rect = $('#cesiumContainer').getBoundingClientRect();

            const left = Math.min(
                Math.max(12, screenX - rect.left + 14),
                rect.width - 315
            );

            const top = Math.min(
                Math.max(55, screenY - rect.top + 14),
                rect.height - 265
            );

            $('#weatherPopup').style.left = left + 'px';
            $('#weatherPopup').style.top = top + 'px';
            $('#weatherPopup').style.right = 'auto';

        } else {
            $('#weatherPopup').classList.remove('hidden');
        }

        if (
            S.selected &&
            Math.abs(S.selected.lat - lat) < 0.0001 &&
            Math.abs(S.selected.lon - lon) < 0.0001
        ) {
            S.selected.name = d.name || S.selected.name;
        }

        return d;

    } catch (e) {
        if (!hover) toast(e.message);
        return null;
    }
}

/* =========================
   ПОИСК МЕСТ
========================= */

$('#searchForm').onsubmit = async e => {
    e.preventDefault();

    $('#searchResults').innerHTML = '';

    try {
        const d = await api(
            '/api/search?q=' +
            encodeURIComponent($('#placeQuery').value.trim())
        );

        const arr = d.results || [];

        $('#searchResults').innerHTML = arr.map((p, i) => `
            <button class="result-chip" data-result="${i}">
                ${esc(p.name)}
                <small>
                    ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}
                </small>
            </button>
        `).join('');

        $$('[data-result]').forEach(b => {
            b.onclick = () => {
                const p = arr[Number(b.dataset.result)];
                loadPlace(p.name, p.lat, p.lon);
            };
        });

        if (arr.length === 1) {
            loadPlace(arr[0].name, arr[0].lat, arr[0].lon);

        } else if (!arr.length) {
            toast('Место не найдено');
        }

    } catch (err) {
        toast(err.message);
    }
};

/* =========================
   НЕБО И МЕСТНОЕ ВРЕМЯ
========================= */

function timeText(epoch, offset) {
    return localTime(epoch, offset);
}

function setSky(d) {
    const sky = $('#sky');

    const now = Date.now() / 1000 + (d.timezone || 0);
    const hour = new Date(now * 1000).getUTCHours();

    let phase = 'day';

    if (hour < 5 || hour >= 21) {
        phase = 'night';

    } else if (hour < 7) {
        phase = 'dawn';

    } else if (hour >= 18) {
        phase = 'sunset';
    }

    sky.classList.remove('night', 'day', 'dawn', 'sunset');
    sky.classList.add(phase);

    const clouds = ['cloud-a', 'cloud-b', 'cloud-c'];
    const cloudMain = String(d.main || '').toLowerCase();

    const count = cloudMain.includes('cloud')
        ? 3
        : cloudMain.includes('rain') || cloudMain.includes('drizzle')
            ? 2
            : Math.random() > 0.62
                ? 1
                : 0;

    clouds.forEach((cl, i) => {
        $('.' + cl).style.display = i < count ? 'block' : 'none';

        $('.' + cl).style.animationDuration =
            (30 + Math.random() * 30) + 's';

        $('.' + cl).style.opacity =
            String(0.35 + Math.random() * 0.55);
    });

    $('#localTime').textContent =
        'Местное время · ' + timeText(Date.now() / 1000, d.timezone);

    $('#daylight').textContent =
        phase === 'night'
            ? 'Ночное небо'
            : phase === 'dawn'
                ? 'Рассвет'
                : phase === 'sunset'
                    ? 'Закатное небо'
                    : 'Дневное небо';
}

/* =========================
   ПОДРОБНАЯ ПОГОДА
========================= */

async function loadPlace(name, lat, lon) {
    showView('weather');

    $('#placeEmpty').classList.add('hidden');
    $('#placeCard').classList.remove('hidden');

    $('#placeTitle').textContent = name;

    $('#placeSubtitle').textContent =
        `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

    $('#currentTemp').textContent = '…';
    $('#currentDesc').textContent = 'Загружаем погоду';

    S.selected = { name, lat, lon };

    try {
        const d = await api(
            `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
        );

        S.selected.name = d.name || name;

        $('#placeTitle').textContent = d.name || name;

        $('#placeSubtitle').textContent =
            `${d.country || ''} · ${lat.toFixed(4)}, ${lon.toFixed(4)}`;

        $('#currentIcon').src =
            `https://openweathermap.org/img/wn/${d.icon}@2x.png`;

        $('#currentTemp').textContent = d.temp + '°C';
        $('#currentDesc').textContent = d.description;

        $('#feelsLike').textContent =
            'Ощущается как ' + d.feels_like + '°C';

        $('#humidity').textContent = d.humidity + '%';
        $('#wind').textContent = d.wind + ' м/с';
        $('#pressure').textContent = (d.pressure || '—') + ' гПа';

        $('#sunrise').textContent = d.sunrise
            ? timeText(d.sunrise, d.timezone)
            : '—';

        $('#sunset').textContent = d.sunset
            ? timeText(d.sunset, d.timezone)
            : '—';

        $('#forecast').innerHTML = (d.forecast || []).map(f => `
            <div class="forecast-day">
                <small>${esc(dateLabel(f.time, d.timezone))}</small>
                <img
                    src="https://openweathermap.org/img/wn/${f.icon}@2x.png"
                    alt=""
                >
                <b>${f.temp}°</b>
                <span>${esc(f.description)}</span>
            </div>
        `).join('') || '<p class="muted">Прогноз недоступен.</p>';

        $('#savePlace').textContent = '＋ Сохранить';

        setSky(d);

        if (S.viewer) {
            S.viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(
                    lon,
                    lat,
                    Math.max(
                        600000,
                        4000000 / Math.max(1, Math.abs(lat) / 20)
                    )
                ),
                duration: 1.6
            });
        }

    } catch (e) {
        toast(e.message);
    }
}

/* =========================
   СОХРАНЁННЫЕ МЕСТА
========================= */

$('#savePlace').onclick = async () => {
    if (!S.selected) return;

    try {
        await api('/api/saved', {
            method: 'POST',
            body: JSON.stringify(S.selected)
        });

        $('#savePlace').textContent = '✓ Сохранено';

        await loadSaved();

        toast('Место сохранено в твоём списке');

    } catch (e) {
        toast(e.message);
    }
};

async function loadSaved() {
    try {
        const d = await api('/api/saved');

        S.saved = d.places;

        $('#savedList').innerHTML = S.saved.map(p => `
            <button class="saved-place" data-saved="${esc(p.id)}">
                <span class="saved-icon">☼</span>
                <span>
                    <b>${esc(p.name)}</b>
                    <small>${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</small>
                </span>
            </button>
        `).join('') || `
            <p class="muted" style="padding:0 9px;font-size:11px">
                Пока нет сохранённых мест
            </p>
        `;

        $$('[data-saved]').forEach(b => {
            b.onclick = () => {
                const p = S.saved.find(x => x.id === b.dataset.saved);

                if (p) {
                    loadPlace(p.name, p.lat, p.lon);
                }
            };
        });

    } catch (e) {
        // Список можно загрузить повторно кнопкой обновления.
    }
}

$('#refreshSaved').onclick = loadSaved;

/* =========================
   МОЁ МЕСТО
========================= */

$('#locateBtn').onclick = () => {
    if (!navigator.geolocation) {
        toast('Геолокация не поддерживается');
        return;
    }

    navigator.geolocation.getCurrentPosition(
        p => {
            const lat = p.coords.latitude;
            const lon = p.coords.longitude;

            showView('earth');

            if (S.viewer) {
                S.viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(
                        lon,
                        lat,
                        500000
                    ),
                    duration: 1.5
                });
            }

            selectCoordinates(lat, lon);
        },

        () => toast('Разреши геолокацию в настройках браузера'),

        {
            enableHighAccuracy: true,
            timeout: 10000
        }
    );
};

/* =========================
   ИИ-ПОМОЩНИК GROQ
========================= */

function addChat(text, role) {
    const e = document.createElement('div');

    e.className = 'chat-message ' + role;
    e.textContent = text;

    $('#chatLog').append(e);
    $('#chatLog').scrollTop = $('#chatLog').scrollHeight;

    return e;
}

async function askAI(text) {
    addChat(text, 'user');

    const wait = addChat('Михаль исследует…', 'assistant');

    try {
        const d = await api('/api/ai', {
            method: 'POST',
            body: JSON.stringify({ message: text })
        });

        wait.textContent = d.reply;

        const match = d.reply.match(
            /\[MAP:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\|\s*([^\]]+)\]/i
        );

        if (match) {
            const lat = Number(match[1]);
            const lon = Number(match[2]);
            const name = match[3].trim();

            wait.textContent = d.reply.replace(
                match[0],
                `Место: ${name} (${lat.toFixed(4)}, ${lon.toFixed(4)}). Открываю на глобусе…`
            );

            S.selected = { name, lat, lon };

            showView('earth');

            if (S.viewer) {
                S.viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(
                        lon,
                        lat,
                        500000
                    ),
                    duration: 1.8
                });
            }

            selectCoordinates(lat, lon);

            setTimeout(() => {
                loadPlace(name, lat, lon);
            }, 800);
        }

    } catch (e) {
        wait.textContent = 'Ошибка: ' + e.message;
    }
}

$('#chatForm').onsubmit = e => {
    e.preventDefault();

    const v = $('#chatInput').value.trim();

    if (!v) return;

    $('#chatInput').value = '';

    askAI(v);
};

$$('[data-ask]').forEach(b => {
    b.onclick = () => askAI(b.dataset.ask);
});

/* =========================
   ОБНОВЛЕНИЕ ИНТЕРФЕЙСА
========================= */

setInterval(() => {
    if (
        S.selected &&
        $('#placeCard') &&
        !$('#placeCard').classList.contains('hidden')
    ) {
        const t = $('#localTime').textContent;

        if (t.startsWith('Местное время')) {
            const m = t.match(/(\d{2}:\d{2})$/);

            if (m) {
                /*
                 * Время обновится при следующем запросе погоды.
                 * Не делаем лишние API-запросы каждую минуту.
                 */
            }
        }
    }
}, 60000);

/* =========================
   СТАРТ
========================= */

(async () => {
    if (S.token) {
        await enterApp();
    } else {
        setAuth('register');
    }
})();
