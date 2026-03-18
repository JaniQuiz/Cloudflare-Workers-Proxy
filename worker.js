addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
      const url = new URL(request.url);

      // 如果访问根目录，返回HTML
      if (url.pathname === "/") {
          return new Response(getRootHtml(), {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
      }

      // 1. 从请求路径中提取目标 URL，并修复丢失域名的前端 API 请求
      let rawPath = decodeURIComponent(url.pathname.substring(1));
      let actualUrlStr = rawPath;

      // 获取路径的第一段来判断是否是完整的域名
      const firstSegment = rawPath.split('/')[0];
      const isDomain = firstSegment.match(/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/) || 
                       firstSegment.match(/^\d{1,3}(\.\d{1,3}){3}$/) || 
                       firstSegment.startsWith("localhost") || 
                       rawPath.startsWith("http");

      if (!isDomain) {
          // 如果不像域名（例如纯 /login），尝试从 Referer 恢复真正的目标站点
          const referer = request.headers.get("Referer");
          if (referer) {
              try {
                  const refererUrl = new URL(referer);
                  let refererTarget = decodeURIComponent(refererUrl.pathname.substring(1));
                  refererTarget = ensureProtocol(refererTarget, url.protocol);
                  const targetOrigin = new URL(refererTarget).origin;
                  actualUrlStr = targetOrigin + url.pathname;
              } catch (e) {
                  actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);
              }
          } else {
              actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);
          }
      } else {
          actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);
      }

      actualUrlStr += url.search;

      // 2. 伪造请求头，防止目标服务器的防跨域 (CORS/CSRF) 拦截
      const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-'));
      try {
          const targetUrlObj = new URL(actualUrlStr);
          newHeaders.set('Host', targetUrlObj.host);
          newHeaders.set('Origin', targetUrlObj.origin);
          newHeaders.set('Referer', targetUrlObj.href);
      } catch (e) {
          // 解析失败时忽略
      }

      // 创建一个新的请求
      const modifiedRequest = new Request(actualUrlStr, {
          headers: newHeaders,
          method: request.method,
          body: request.body,
          redirect: 'manual'
      });

      const response = await fetch(modifiedRequest);
      // ==========================================
      // [新增] WebSocket 专属直通通道
      // 如果请求头包含 Upgrade: websocket，或者响应状态码是 101
      // 必须直接返回原始 response，交由底层接管 TCP 流，绝不能修改 body 或 headers
      if (
          request.headers.get("Upgrade")?.toLowerCase() === "websocket" || 
          response.status === 101
      ) {
          return response;
      }
      // ==========================================
      let body = response.body;

      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(response.status)) {
          body = response.body;
          // 传入 actualUrlStr 以修复目标站点返回相对路径重定向的问题
          return handleRedirect(response, body, actualUrlStr);
      } else if (response.headers.get("Content-Type")?.includes("text/html")) {
          body = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
      }

      // 3. 修复 Cookie 的 Domain 限制，确保登录态可以保存在代理域名下
      const responseHeaders = new Headers(response.headers);
      if (responseHeaders.has("Set-Cookie")) {
          // 兼容 Cloudflare Workers 的 getSetCookie 数组方法
          const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [responseHeaders.get("Set-Cookie")];
          responseHeaders.delete("Set-Cookie");
          for (let cookie of cookies) {
              if (cookie) {
                  // 移除 domain=xxx 属性，让浏览器默认将 Cookie 种在当前代理域名下
                  let newCookie = cookie.replace(/domain=[^;]+;?/gi, '');
                  responseHeaders.append("Set-Cookie", newCookie);
              }
          }
      }

      setNoCacheHeaders(responseHeaders);
      setCorsHeaders(responseHeaders);

      return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
      });

  } catch (error) {
      return jsonResponse({ error: error.message }, 500);
  }
}

// 确保 URL 带有协议
function ensureProtocol(url, defaultProtocol) {
  return url.startsWith("http://") || url.startsWith("https://") ? url : defaultProtocol + "//" + url;
}

// 处理重定向
// 修复后的 handleRedirect：支持处理相对路径重定向（例如 Location: /dashboard）
function handleRedirect(response, body, actualUrlStr) {
  let locationStr = response.headers.get('location');
  try {
      // 如果 target 返回的是相对路径，需要结合实际目标 URL 获取绝对路径
      const targetOrigin = new URL(actualUrlStr).origin;
      const locationUrl = new URL(locationStr, targetOrigin);
      const modifiedLocation = `/${encodeURIComponent(locationUrl.toString())}`;
      
      const newHeaders = new Headers(response.headers);
      newHeaders.set('Location', modifiedLocation);

      return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
      });
  } catch (e) {
      return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
      });
  }
}

// 处理 HTML 内容中的相对路径
// 替换原有的 handleHtmlContent 方法
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
    const originalText = await response.text();
    const targetOrigin = new URL(actualUrlStr).origin;
    
    // 1. 基础的正则替换（保留你原有的逻辑，处理静态标签）
    let modifiedText = replaceRelativePaths(originalText, protocol, host, targetOrigin);

    // 2. 提取当前请求的目标域名（例如 github.com）
    const targetHost = new URL(actualUrlStr).host;

    // 3. 将拦截器脚本注入到 <head> 的最前面
    const injectScript = getInjectScript(targetHost);
    
    // 尝试在 <head> 标签后注入，如果没有 <head>，则在最前面注入
    if (modifiedText.includes('<head>')) {
        modifiedText = modifiedText.replace('<head>', `<head>\n${injectScript}\n`);
    } else if (modifiedText.includes('<head ')) {
        modifiedText = modifiedText.replace(/(<head[^>]*>)/i, `$1\n${injectScript}\n`);
    } else {
        modifiedText = injectScript + modifiedText;
    }

    return modifiedText;
}

// 新增方法：生成需要注入的前端拦截器脚本
// 生成需要注入的前端拦截器脚本（包含 WebSocket 支持）
function getInjectScript(targetHost) {
    return `
    <script>
    (function() {
        const proxyOrigin = window.location.origin;
        const targetHost = "${targetHost}";
        const targetPrefix = proxyOrigin + '/' + targetHost;
        
        // 动态计算代理站点的 WebSocket 协议 (http -> ws, https -> wss)
        const proxyWsOrigin = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host;

        // URL 重写核心逻辑 (升级支持 ws/wss)
        function rewriteUrl(url) {
            if (!url) return url;
            let urlStr = String(url);
            
            if (urlStr.startsWith(proxyOrigin) || urlStr.startsWith(proxyWsOrigin)) return urlStr;
            
            // 拦截绝对路径
            if (urlStr.startsWith('/') && !urlStr.startsWith('//')) {
                return targetPrefix + urlStr;
            }
            
            // 拦截 HTTP/HTTPS
            if (urlStr.startsWith('http')) {
                try {
                    let u = new URL(urlStr);
                    if (u.host === targetHost) {
                        return targetPrefix + u.pathname + u.search + u.hash;
                    }
                    return proxyOrigin + '/' + u.host + u.pathname + u.search + u.hash;
                } catch(e) { return urlStr; }
            }

            // 拦截 WS/WSS
            if (urlStr.startsWith('ws://') || urlStr.startsWith('wss://')) {
                try {
                    let u = new URL(urlStr);
                    // 强制将目标 WS 地址转换为通过代理域名的 WS 地址
                    return proxyWsOrigin + '/' + u.host + u.pathname + u.search;
                } catch(e) { return urlStr; }
            }

            return urlStr;
        }

        // 1. 劫持 fetch
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            let [resource, config] = args;
            if (typeof resource === 'string' || resource instanceof URL) {
                resource = rewriteUrl(resource);
            } else if (resource instanceof Request) {
                const newUrl = rewriteUrl(resource.url);
                resource = new Request(newUrl, resource);
            }
            return originalFetch.call(this, resource, config);
        };

        // 2. 劫持 XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            url = rewriteUrl(url);
            return originalOpen.call(this, method, url, ...rest);
        };

        // 3. 劫持 History API
        const originalPushState = history.pushState;
        history.pushState = function(state, title, url) {
            if (url) url = rewriteUrl(url);
            return originalPushState.call(this, state, title, url);
        };
        const originalReplaceState = history.replaceState;
        history.replaceState = function(state, title, url) {
            if (url) url = rewriteUrl(url);
            return originalReplaceState.call(this, state, title, url);
        };

        // 4. 劫持原生 window.open
        const originalWindowOpen = window.open;
        window.open = function(url, target, features) {
            if (url) url = rewriteUrl(url);
            return originalWindowOpen.call(this, url, target, features);
        };

        // 5. [终极覆盖] 劫持 WebSocket
        const originalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            // 重写传入的 WS URL
            let rewrittenUrl = rewriteUrl(url);
            
            // 实例化原生 WebSocket
            let wsInstance;
            if (protocols) {
                wsInstance = new originalWebSocket(rewrittenUrl, protocols);
            } else {
                wsInstance = new originalWebSocket(rewrittenUrl);
            }
            return wsInstance;
        };
        // 继承原生 WebSocket 的静态属性和原型，防止某些库的类型校验失败
        window.WebSocket.prototype = originalWebSocket.prototype;
        window.WebSocket.CONNECTING = originalWebSocket.CONNECTING;
        window.WebSocket.OPEN = originalWebSocket.OPEN;
        window.WebSocket.CLOSING = originalWebSocket.CLOSING;
        window.WebSocket.CLOSED = originalWebSocket.CLOSED;

        console.log("[CF Proxy] Ultimate Interceptors (inc. WebSocket) Injected for:", targetHost);
    })();
    </script>
    `;
}

// 替换 HTML 内容中的相对路径
function replaceRelativePaths(text, protocol, host, origin) {
  const regex = new RegExp('((href|src|action)=["\'])/(?!/)', 'g');
  return text.replace(regex, `$1${protocol}//${host}/${origin}/`);
}

// 返回 JSON 格式的响应
function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
      status: status,
      headers: {
          'Content-Type': 'application/json; charset=utf-8'
      }
  });
}

// 过滤请求头
function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

// 设置禁用缓存的头部
function setNoCacheHeaders(headers) {
  headers.set('Cache-Control', 'no-store');
}

// 设置 CORS 头部
function setCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  headers.set('Access-Control-Allow-Headers', '*');
}

// 返回根目录的 HTML
function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html {
          height: 100%;
          margin: 0;
      }
      .background {
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] {
          color: #2c3e50;
      }
      .input-field input[type=text]:focus+label {
          color: #2c3e50 !important;
      }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
      @media (prefers-color-scheme: dark) {
          body, html {
              background-color: #121212;
              color: #e0e0e0;
          }
          .card {
              background-color: rgba(33, 33, 33, 0.9);
              color: #ffffff;
          }
          .card:hover {
              background-color: rgba(50, 50, 50, 1);
              box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.6);
          }
          .input-field input[type=text] {
              color: #ffffff;
          }
          .input-field input[type=text]:focus+label {
              color: #ffffff !important;
          }
          .input-field input[type=text]:focus {
              border-bottom: 1px solid #ffffff !important;
              box-shadow: 0 1px 0 0 #ffffff !important;
          }
          label {
              color: #cccccc;
          }
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}
