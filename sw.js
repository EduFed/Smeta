/* ============================================================
   Service Worker — офлайн-режим приложения «СМЕТА | РАСЧЁТ»

   Версию ниже нужно менять при каждой выкладке нового index.html —
   тем же значением, что стоит в APP_BUILD внутри index.html.
   Если этого не сделать, браузеры продолжат отдавать людям
   старый index.html из кэша.
   ============================================================ */

const CACHE_VERSION = '2026-09-05-243';

const CACHE_APP = 'smeta-app-' + CACHE_VERSION;   // файлы приложения — своя версия у каждой сборки

// ВАЖНО: кэш библиотек НЕ привязан к версии сборки.
// Раньше он назывался 'smeta-lib-<версия>' и при каждой новой сборке стирался
// вместе с библиотеками. Из-за этого приложение переставало открываться офлайн:
// без библиотеки Supabase оно даже не доходит до данных.
const CACHE_LIB = 'smeta-lib-v2';

// ХРАНИЛИЩЕ СНИМКОВ — МИМО СЛУЖЕБНОГО РАБОТНИКА ЦЕЛИКОМ.
//
// До 27 августа 2026 снимки попадали в общее правило «чужой сайт — в кэш»
// (ветка ниже, писалась под библиотеки и шрифты). Для снимков она вредна:
// адрес подписанный и живёт восемь минут, значит ключ у каждого показа
// свой, совпадений почти не бывает, сеть дёргается всё равно, а запись
// в CACHE_LIB остаётся навсегда — этот кэш нарочно переживает смену
// сборки и никем не чистится.
//
// Дойдя до предела хранилища, браузер стирает его ЦЕЛИКОМ — вместе
// с тем, что там держит само приложение. Мусор, не сэкономивший ни байта,
// однажды вытеснил бы то, что экономит.
//
// Теперь снимки хранит само приложение, по номеру снимка, в своей области
// (см. блок «СКЛАД СНИМКОВ» в index.html). Служебному работнику здесь
// делать нечего.
function fotoHranilishche(hostname){
  return /(^|\.)storage\.beget\.cloud$/i.test(hostname || '');
}

// файлы приложения — кладём в кэш сразу при установке
// './' здесь НЕТ намеренно: это тот же файл, что и './index.html', но
// другой ключ кэша — приложение весом полтора мегабайта легло бы дважды.
// Чтение всё равно идёт по './index.html' (см. ветку навигации).
const APP_SHELL = [
  './index.html',
  './privacy.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-192-ink.png',
  './icon-512-ink.png',
  './icon-maskable-512.png'
];

// Внешние библиотеки, без которых приложение НЕ ЗАПУСКАЕТСЯ.
// Кладём их в кэш сразу при установке, а не «когда-нибудь при первом обращении»:
// на первом заходе Service Worker ещё не управляет страницей и поймать
// эти запросы не успевает.
const CRITICAL_LIBS = [
  'https://api.smetaraschet.ru/static/lib/supabase.js',
  'https://api.smetaraschet.ru/static/fonts.css'
];

self.addEventListener('install', (e)=>{
  e.waitUntil((async ()=>{
    const app = await caches.open(CACHE_APP);
    // addAll падает целиком, если хоть один файл недоступен, — кладём по одному
    // и ЗАПОМИНАЕМ, что не легло: этим решается, можно ли выбрасывать
    // прежний кэш при активации (см. activate ниже).
    const nelegli = [];
    await Promise.all(APP_SHELL.map(u =>
      app.add(new Request(u, { cache: 'reload' })).catch(()=> nelegli.push(u))
    ));
    // Что именно не легло — видно в отладчике; решение «сносить ли старый
    // кэш» принимает activate, и принимает его по факту: лежит ли в новом
    // кэше само приложение. Так надёжнее переменной: работник между
    // install и activate может быть выгружен, и переменная не переживёт.
    if(nelegli.length) console.warn('Не закэшировано при установке:', nelegli);

    const lib = await caches.open(CACHE_LIB);
    await Promise.all(CRITICAL_LIBS.map(async (u)=>{
      try{
        // no-cors: чужой сайт не разрешает читать ответ, но сохранить его можно
        const res = await fetch(u, { mode: 'no-cors', cache: 'reload' });
        await lib.put(u, res);
      }catch(_){}
    }));

    // ВАЖНО: skipWaiting здесь НЕ вызываем. Раньше он стоял в конце install —
    // и новая версия активировалась сразу, в обход плашки «Доступна новая
    // версия» и её защиты «не обновляться, пока данные не отправлены».
    // Теперь новая версия ждёт, пока человек сам нажмёт «Обновить»
    // (страница пришлёт сообщение SKIP_WAITING — обработчик ниже).
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    // ПРЕЖНИЙ КЭШ УБИРАЕМ, ТОЛЬКО ЕСЛИ НОВЫЙ ПОЛОН.
    // Установка кладёт файлы по одному и молча терпит неудачи —
    // значит работник может установиться с половиной приложения.
    // Снести после этого рабочий кэш означало бы отобрать офлайн
    // у человека, у которого просто моргнула связь.
    const est = await (await caches.open(CACHE_APP)).match('./index.html');
    if(est){
      await Promise.all(
        keys.filter(k => k.startsWith('smeta-app-') && k !== CACHE_APP)
            .map(k => caches.delete(k))
      );
    }
    // Старые кэши библиотек убираем: в них лежат файлы с чужих серверов
    // (jsDelivr, Google, cdnjs), приложение к ним больше не обращается.
    // Текущий CACHE_LIB намеренно НЕ трогаем — библиотеки должны пережить обновление.
    await Promise.all(
      keys.filter(k => k.startsWith('smeta-lib-') && k !== CACHE_LIB)
          .map(k => caches.delete(k))
    );

    // ВЫЧИСТИТЬ НАКОПЛЕННОЕ. До 27 августа 2026 в CACHE_LIB оседали копии
    // снимков под подписанными адресами — мёртвый груз, который сам
    // не уйдёт: этот кэш версией сборки не чистится (см. выше).
    // Проход дешёвый: после первого раза удалять уже нечего.
    try{
      const lib = await caches.open(CACHE_LIB);
      const zapisi = await lib.keys();
      await Promise.all(zapisi.filter(r=>{
        try{ return fotoHranilishche(new URL(r.url).hostname); }catch(_){ return false; }
      }).map(r => lib.delete(r)));
    }catch(_){}

    await self.clients.claim();
  })());
});

// сообщение от страницы: применить новую версию немедленно
self.addEventListener('message', (e)=>{
  if(e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // Запросы к Supabase (данные, авторизация) НИКОГДА не кэшируем:
  // иначе человек увидит чужие или устаревшие сметы.
  // Свой сервер отдаёт две разные вещи, и обращаться с ними надо по-разному:
  //   /static/... — шрифты и библиотеки, их НУЖНО кэшировать,
  //                 без них приложение не открывается без интернета;
  //   всё остальное (/auth/, /rest/) — данные и авторизация,
  //                 их кэшировать НЕЛЬЗЯ: человек увидит чужие
  //                 или устаревшие сметы.
  // Имён у сервера два, оба ведут на один и тот же адрес и сертификат:
  // api — основное, data — запасное (заведено 23 июля 2026, когда
  // подозревали фильтрацию по имени; причина оказалась в версии TLS).
  // Обрабатываем оба, чтобы переключение не требовало правки этого файла.
  const OUR_SERVER = (url.hostname === 'api.smetaraschet.ru' ||
                      url.hostname === 'data.smetaraschet.ru');
  if(OUR_SERVER && !url.pathname.startsWith('/static/')){
    return;   // пропускаем в сеть как есть
  }

  // Хранилище снимков — тоже мимо, и по своей причине (см. fotoHranilishche
  // в начале файла). Стоять это должно ВЫШЕ общей ветки «чужой сайт»,
  // иначе она перехватит запрос первой.
  if(fotoHranilishche(url.hostname)){
    return;   // снимки хранит приложение, по номеру, а не по подписи
  }

  // Переходы по страницам: СНАЧАЛА копия с устройства, сеть — в фоне.
  // Приложение открывается мгновенно при любом состоянии сети.
  //
  // ВАЖНО: только для самого приложения. Раньше сюда попадал ЛЮБОЙ переход,
  // включая privacy.html — и вместо политики отдавался index.html.
  // Хуже того, ответ сохранялся ПОД ИМЕНЕМ index.html и портил кэш
  // приложения. Со стороны это выглядело так: первое нажатие на ссылку
  // перезагружает приложение, и лишь второе открывает политику.
  // ГЛАВНАЯ СТРАНИЦА — ЭТО ОДИН АДРЕС, А НЕ «ВСЁ, ЧТО КОНЧАЕТСЯ КОСОЙ».
  // Прежде здесь стояло `pathname.endsWith('/')`, и главной считался любой
  // адрес с косой чертой на конце. Приложение лежит в корне, значит
  // и /docs/, и /admin/, и любая будущая папка попали бы сюда — а эта
  // ветка ПИШЕТ ответ в кэш под именем index.html. Одного такого адреса
  // хватило бы, чтобы подменить приложение. Найдено 5 сентября 2026
  // сторонней проверкой кода.
  //
  // Считаем от области самого работника: она и есть тот каталог,
  // где живёт приложение.
  const koren = new URL('./', self.registration.scope).pathname;
  const isAppPage = (url.origin === self.location.origin) &&
                    (url.pathname === koren || url.pathname === koren + 'index.html');
  if(req.mode === 'navigate' && isAppPage){
    e.respondWith((async ()=>{
      const cache = await caches.open(CACHE_APP);
      // В КЭШ ПРИЛОЖЕНИЯ КЛАДЁМ ТОЛЬКО УСПЕШНЫЙ HTML СО СВОЕГО СЕРВЕРА.
      //
      // Прежде сюда шёл ЛЮБОЙ ответ: 404, 500, страница провайдера,
      // проверка Cloudflare. Он ложился под именем index.html — и человек
      // получал вместо приложения чужую страницу, НАВСЕГДА: приложение
      // офлайн-первое, оно берёт из кэша не глядя, и починить это можно
      // было бы только очисткой данных сайта.
      //
      // Самая опасная находка проверки 5 сентября 2026: тихая, необратимая
      // для человека и тем более вероятная, чем хуже у него связь.
      const godnyy = (res)=> !!res && res.ok && res.type === 'basic' &&
        /text\/html/i.test(res.headers.get('content-type') || '');
      const net = fetch(req).then(res=>{
        if(godnyy(res)) e.waitUntil(cache.put('./index.html', res.clone()));
        return res;
      }).catch(()=> null);
      // держим Service Worker живым, пока фоновая загрузка не закончится
      e.waitUntil(net.then(()=>{}).catch(()=>{}));

      // Сначала — копия с устройства. Ждать сеть нельзя даже секунды:
      // 21 июля 2026 выяснилось, что с адресов некоторых стран сервер
      // недоступен вовсе (человек под VPN). Браузер честно выжидал
      // отведённое время, и всё это время человек смотрел на белый экран,
      // хотя рабочая копия лежала в кэше рядом.
      // Свежая версия скачивается в фоне и приезжает при следующем запуске
      // либо по нажатию «Обновить» в плашке — она появляется сама.
      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      if(cached) return cached;

      // кэша нет (самый первый заход) — деваться некуда, ждём сеть до конца
      const late = await net;
      return late || new Response('Нет сети', { status: 503 });
    })());
    return;
  }

  // Библиотеки и шрифты С НАШЕГО СЕРВЕРА: сначала кэш (быстро и работает
  // офлайн), в фоне обновляем.
  //
  // БЕЛЫЙ СПИСОК, А НЕ «ВСЁ ЧУЖОЕ». Прежде условием было «origin не наш» —
  // и в CACHE_LIB оседал любой сторонний GET, какой бы ни случился.
  // Этот кэш нарочно переживает смену сборки и ничем не чистится, то есть
  // растёт без предела. Одну такую утечку уже чинили 27 августа 2026
  // (снимки по подписанным адресам) — заплаткой на конкретный случай.
  // Заплатка ловит известное; белый список ловит и то, о чём не подумали.
  const nashiStatika = (url.hostname === 'api.smetaraschet.ru' ||
                        url.hostname === 'data.smetaraschet.ru') &&
                       url.pathname.startsWith('/static/');
  if(nashiStatika){
    e.respondWith((async ()=>{
      const cache = await caches.open(CACHE_LIB);
      const hit = await cache.match(req);
      const net = fetch(req).then(res=>{
        if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(()=> null);
      return hit || (await net) || new Response('', { status: 504 });
    })());
    return;
  }

  // Прочие свои страницы (privacy.html): сначала сеть, при неудаче кэш.
  // Кэшируем под собственным адресом, а не под именем приложения.
  if(req.mode === 'navigate'){
    e.respondWith((async ()=>{
      const cache = await caches.open(CACHE_APP);
      try{
        const res = await fetch(req);
        if(res && res.ok) cache.put(req, res.clone());
        return res;
      }catch(_){
        const hit = await cache.match(req);
        return hit || new Response('Нет сети', { status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // Свои файлы (иконки, манифест): кэш → сеть
  e.respondWith((async ()=>{
    const cache = await caches.open(CACHE_APP);
    const hit = await cache.match(req);
    if(hit) return hit;
    try{
      const res = await fetch(req);
      if(res && res.ok) cache.put(req, res.clone());
      return res;
    }catch(_){
      return new Response('', { status: 504 });
    }
  })());
});
