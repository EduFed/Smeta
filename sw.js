/* ============================================================
   Service Worker — офлайн-режим приложения «СМЕТА | РАСЧЁТ»

   Версию ниже нужно менять при каждой выкладке нового index.html —
   тем же значением, что стоит в APP_BUILD внутри index.html.
   Если этого не сделать, браузеры продолжат отдавать людям
   старый index.html из кэша.
   ============================================================ */

const CACHE_VERSION = '2026-07-20-04';

const CACHE_APP = 'smeta-app-' + CACHE_VERSION;   // файлы приложения — своя версия у каждой сборки

// ВАЖНО: кэш библиотек НЕ привязан к версии сборки.
// Раньше он назывался 'smeta-lib-<версия>' и при каждой новой сборке стирался
// вместе с библиотеками. Из-за этого приложение переставало открываться офлайн:
// без библиотеки Supabase оно даже не доходит до данных.
const CACHE_LIB = 'smeta-lib-v2';

// файлы приложения — кладём в кэш сразу при установке
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
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
    await Promise.all(APP_SHELL.map(u =>
      app.add(new Request(u, { cache: 'reload' })).catch(()=>{})
    ));

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
    await Promise.all(
      keys.filter(k => k.startsWith('smeta-app-') && k !== CACHE_APP)
          .map(k => caches.delete(k))
    );
    // Старые кэши библиотек убираем: в них лежат файлы с чужих серверов
    // (jsDelivr, Google, cdnjs), приложение к ним больше не обращается.
    // Текущий CACHE_LIB намеренно НЕ трогаем — библиотеки должны пережить обновление.
    await Promise.all(
      keys.filter(k => k.startsWith('smeta-lib-') && k !== CACHE_LIB)
          .map(k => caches.delete(k))
    );
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
  // Капча Cloudflare — тоже мимо кэша.
  // Свой сервер отдаёт две разные вещи, и обращаться с ними надо по-разному:
  //   /static/... — шрифты и библиотеки, их НУЖНО кэшировать,
  //                 без них приложение не открывается без интернета;
  //   всё остальное (/auth/, /rest/) — данные и авторизация,
  //                 их кэшировать НЕЛЬЗЯ: человек увидит чужие
  //                 или устаревшие сметы.
  if(url.hostname === 'api.smetaraschet.ru' && !url.pathname.startsWith('/static/')){
    return;   // пропускаем в сеть как есть
  }

  // Переходы по страницам: сначала сеть (чтобы получать обновления),
  // но ждём её НЕ ДОЛЬШЕ 3,5 секунд. Раньше таймаута не было, и при
  // «висящем» интернете (телефон думает, что сеть есть, но данные не идут)
  // fetch ждал ответа минутами — человек видел белый экран, приложение
  // «не открывалось», хотя рабочая копия лежала в кэше рядом.
  // Теперь: сеть ответила быстро — отдаём свежую версию; не успела —
  // отдаём кэш, а сеть, если всё же ответит, молча обновит кэш в фоне
  // (обновление приедет при следующем открытии).
  if(req.mode === 'navigate'){
    e.respondWith((async ()=>{
      const cache = await caches.open(CACHE_APP);
      const net = fetch(req).then(res=>{
        cache.put('./index.html', res.clone());
        return res;
      }).catch(()=> null);
      // держим Service Worker живым, пока фоновая загрузка не закончится
      e.waitUntil(net.then(()=>{}).catch(()=>{}));

      const first = await Promise.race([
        net,
        new Promise(r => setTimeout(()=> r('TIMEOUT'), 3500))
      ]);
      if(first && first !== 'TIMEOUT') return first;

      const cached = (await cache.match('./index.html')) || (await cache.match('./'));
      if(cached) return cached;

      // кэша нет (самый первый заход) — деваться некуда, ждём сеть до конца
      const late = await net;
      return late || new Response('Нет сети', { status: 503 });
    })());
    return;
  }

  // Библиотеки и шрифты с чужих сайтов: сначала кэш (быстро и работает офлайн),
  // в фоне обновляем.
  if(url.origin !== self.location.origin){
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
