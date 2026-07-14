/* ============================================================
   Service Worker — офлайн-режим приложения «СМЕТА | РАСЧЁТ»

   Версия ниже меняется автоматически при каждой сборке.
   Ничего править вручную не нужно — просто заливайте
   sw.js вместе с index.html.

   Если версия не изменится, браузеры продолжат отдавать
   людям старый index.html из кэша.
   ============================================================ */

const CACHE_VERSION = '2026-07-13-17';
const CACHE_APP = 'smeta-app-' + CACHE_VERSION;   // сам файл приложения
const CACHE_LIB = 'smeta-lib-' + CACHE_VERSION;   // библиотеки и шрифты с CDN

// файлы приложения — кладём в кэш сразу при установке
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (e)=>{
  e.waitUntil((async ()=>{
    const cache = await caches.open(CACHE_APP);
    // addAll падает целиком, если хоть один файл недоступен, — кладём по одному
    await Promise.all(APP_SHELL.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(()=>{})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('smeta-') && !k.endsWith(CACHE_VERSION))
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

  // Библиотеки и шрифты с CDN: сначала кэш (быстро и работает офлайн),
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
