/* ============================================================
   Service Worker — офлайн-режим приложения «СМЕТА | РАСЧЁТ»

   Версию ниже нужно менять при каждой выкладке нового index.html —
   тем же значением, что стоит в APP_BUILD внутри index.html.
   Если этого не сделать, браузеры продолжат отдавать людям
   старый index.html из кэша.
   ============================================================ */

const CACHE_VERSION = '2026-07-13-30';

const CACHE_APP = 'smeta-app-' + CACHE_VERSION;   // файлы приложения — своя версия у каждой сборки

// ВАЖНО: кэш библиотек НЕ привязан к версии сборки.
// Раньше он назывался 'smeta-lib-<версия>' и при каждой новой сборке стирался
// вместе с библиотеками. Из-за этого приложение переставало открываться офлайн:
// без библиотеки Supabase оно даже не доходит до данных.
const CACHE_LIB = 'smeta-lib-v1';

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
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;600&display=swap'
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

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('smeta-app-') && k !== CACHE_APP)
          .map(k => caches.delete(k))
    );
    // CACHE_LIB намеренно НЕ трогаем — библиотеки должны пережить обновление
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
  if(url.hostname.endsWith('supabase.co') ||
     url.hostname.endsWith('cloudflare.com') ||
     url.hostname.includes('challenges.cloudflare')){
    return;   // пропускаем в сеть как есть
  }

  // Переходы по страницам: сначала сеть (чтобы получать обновления),
  // при её отсутствии — версия из кэша. Так приложение открывается офлайн.
  if(req.mode === 'navigate'){
    e.respondWith((async ()=>{
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_APP);
        cache.put('./index.html', fresh.clone());
        return fresh;
      }catch(_){
        const cache = await caches.open(CACHE_APP);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               new Response('Нет сети', { status: 503 });
      }
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
