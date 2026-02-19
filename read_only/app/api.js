import axios from 'axios';
export const API_URL =
  process.env.VITE_API_BASE_URL ||
  "http://localhost:8000";
axios.defaults.withCredentials = true;

const authReadyGate = {
  readyPromise: null,
  resolve: null,
};

function initAuthReadyGate() {
  if (!authReadyGate.readyPromise) {
    authReadyGate.readyPromise = new Promise((resolve) => {
      authReadyGate.resolve = resolve;
    });
  }
}

initAuthReadyGate();

export function markAuthReady() {
  if (authReadyGate.resolve) {
    authReadyGate.resolve();
    authReadyGate.resolve = null;
    authReadyGate.readyPromise = Promise.resolve();
  }
}

export async function waitForAuthReady() {
  if (authReadyGate.readyPromise) {
    await authReadyGate.readyPromise;
  }
}

async function get_refresh(url) {
  return axios.get(url)
  .catch(err => {
    if (err.response?.status === 401) {
      return axios.get(`${API_URL}/auth/refresh`)
      .then(res => axios.get(url));
    }
  })
}

async function post_refresh(url, data) {
  return axios.post(url, data)
  .catch(err => {
    if (err.response?.status === 401) {
      return axios.get(`${API_URL}/auth/refresh`)
      .then(res => axios.post(url, data));
    }
  })
}

async function put_refresh(url, data) {
  return axios.put(url, data)
  .catch(err => {
    if (err.response?.status === 401) {
      return axios.get(`${API_URL}/auth/refresh`)
      .then(res => axios.put(url, data));
    }
  })
}

async function delete_refresh(url) {
  return axios.delete(url)
  .catch(err => {
    if (err.response?.status === 401) {
      return axios.get(`${API_URL}/auth/refresh`)
      .then(res => axios.delete(url));
    }
  })
}

async function get(url) {
  //await waitForAuthReady();
  return get_refresh(url);
}

async function post(url, data) {
  //await waitForAuthReady();
  return post_refresh(url, data);
}

async function put(url, data) {
  //await waitForAuthReady();
  return put_refresh(url, data);
}

async function deleteRequest(url) {
  //await waitForAuthReady();
  return delete_refresh(url);
}

// === OAuth ===
export async function fetchMe() {
    return get_refresh(`${API_URL}/auth/me`)
    .then(res => res.data)
    .catch(err => null)
}
export function startGoogleLogin() {
  const returnTo = window.location.href;
  // 백엔드로 바로 리다이렉트(백엔드가 구글로 다시 리다이렉트)
  window.location.href = `${API_URL}/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}
export async function logout() {await post(`${API_URL}/auth/logout`);}


// === Read APIs ===
export const swSearch = (payload) => post(`${API_URL}/api/sw_search`, payload);
export const swFilterOptions = () => get(`${API_URL}/api/sw_filter_options`);
export const swDetail = (fullName) => get(`${API_URL}/api/sw_detail/${encodeURIComponent(fullName)}`);
