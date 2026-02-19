import axios from 'axios';
export const API_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
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
  await waitForAuthReady();
  return get_refresh(url);
}

async function post(url, data) {
  await waitForAuthReady();
  return post_refresh(url, data);
}

async function put(url, data) {
  await waitForAuthReady();
  return put_refresh(url, data);
}

async function deleteRequest(url) {
  await waitForAuthReady();
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

// === Words CRUD ===
export const updateJpWordsBatch = (wordsData) => post(`${API_URL}/words/update/jp/batch`, wordsData);
export const deleteJpWordsBatch = (wordIds) => post(`${API_URL}/words/delete/jp/batch`, wordIds);
export const updateEnWordsBatch = (wordsData) => post(`${API_URL}/words/update/en/batch`, wordsData);
export const deleteEnWordsBatch = (wordIds) => post(`${API_URL}/words/delete/en/batch`, wordIds);
export const searchJpWordsByWord = (searchTerm) => get(`${API_URL}/words/search/${encodeURIComponent(searchTerm)}`);
export const saveWordInExample = (language, exampleId, wordData) => {post(`${API_URL}/words/save-word-in-example`, { language: language, example_id: exampleId, word_data: wordData });}
export const saveWordSkill = (language, wordId, reading) => post(`${API_URL}/words/save-word-skill`, { language: language, word_id: wordId, reading: reading });
export const saveWordSkillsBatch = (language, skillType, wordSkills) => post(`${API_URL}/words/save-word-skills-batch`, { language: language, skill_type: skillType, word_skills: wordSkills });
export const deleteWordsPersonal = (language, wordIds) => post(`${API_URL}/words/delete/personal`, { language: language, word_ids: wordIds });
export const getRandomWordsToLearn = (limit) => get(`${API_URL}/words/personal/random/${limit}`);
export const filterWords = (wordFilterData) => post(`${API_URL}/words/filter`, wordFilterData);

// === Examples CRUD ===
export const createExamplesBatch = (examplesData) => post(`${API_URL}/examples/save/batch`, examplesData);
export const updateExamplesBatch = (examplesData) => post(`${API_URL}/examples/save/batch`, examplesData);
export const readExamplesBatch = (exampleIds) => post(`${API_URL}/examples/read/batch`, exampleIds);
export const deleteExamplesBatch = (exampleIds) => post(`${API_URL}/examples/delete/batch`, exampleIds);
export const filterExamples = (exampleFilterData) => post(`${API_URL}/examples/filter`, exampleFilterData);
export const findExamplesByText = (language='jp', text='', limit=6) => post(`${API_URL}/examples/find-examples-by-text`, { language, text, limit });
export const getExamplesForUser = (language="jp", keyword_ids = [], maxLevel = "N1", method = "reading", limit = null) =>
  post(`${API_URL}/examples/get-examples-for-user`, { language, keyword_ids, maxLevel, method, limit });
export const getExamplesForGuest = (language="jp", keyword_ids = [], maxLevel = "N1", method = "reading", limit = null, skills = {}) =>
  post(`${API_URL}/examples/get-examples-for-guest`, { language, keyword_ids, maxLevel, method, limit, skills });
export const getQuizForUser = (tags = [], maxLevel = "N1", words = [], limit = 10) =>
  post(`${API_URL}/examples/get-quiz-for-user`, { tags, maxLevel, words, limit });
export const createErrorReport = (errorReportData) => post(`${API_URL}/error_report/create`, errorReportData);

// === Keywords CRUD ===
export const getKeywords = () => get(`${API_URL}/keywords/`);
export const getKeywordsWithExampleCounts = () => get(`${API_URL}/keywords/with-example-counts`);
export const createKeyword = (keywordData) => post(`${API_URL}/keywords/create`, keywordData);
export const updateKeyword = (keywordData) => put(`${API_URL}/keywords/update`, keywordData);
export const deleteKeyword = (keywordId) => deleteRequest(`${API_URL}/keywords/${keywordId}`);
export const bulkUpsertExampleKeyword = (exampleKeywordAssignments) => post(`${API_URL}/keywords/examples/bulk-upsert`, exampleKeywordAssignments);
export const getExamplesByKeywordPaged = (keywordId,offset = 0,limit = 20) =>post(`${API_URL}/keywords/examples/paged`,{ keyword_id: Number(keywordId), offset, limit });
export const getRecommendedExamplesForKeyword = (keywordId,exampleId = null,tag = null,limit = 10) =>post(`${API_URL}/keywords/examples/recommended`,{ keyword_id: Number(keywordId), example_id: exampleId, tag, limit });

// === Text Analysis ===
export const analyzeJpText = (text) => post(`${API_URL}/text/analyze/jp`, { text });
export const analyzeEnText = (text) => post(`${API_URL}/text/analyze/en`, { text });
export const analyzeTextForGuest = (language="jp", text="", skills={}) => post(`${API_URL}/text/analyze/guest`, { language, text, skills });

// === User Text CRUD ===
export const createUserText = (userTextData) => post(`${API_URL}/user_text/create`, userTextData);
export const getUserText = (userTextId) => get(`${API_URL}/user_text/get/${userTextId}`);
export const getUserTextList = (limit = null, offset = null) => get(`${API_URL}/user_text/all`, { params: { limit, offset } });
export const updateUserText = (userTextData) => post(`${API_URL}/user_text/update`, userTextData);
export const deleteUserText = (userTextId) => get(`${API_URL}/user_text/delete/${userTextId}`);

// === User Data CRUD ===
export const getAllUsersAdmin = (limit = null, offset = null) => get(`${API_URL}/user_admin/get_all_users/${encodeURIComponent(limit)}/${encodeURIComponent(offset)}`);
export const deleteUserAdmin = (id) => get(`${API_URL}/user_admin/delete/${id}`);
export const getUserSummaryAdmin = (userId) => get(`${API_URL}/user_data/summary/admin/${userId}`);
export const getUserSummaryUser = () => get(`${API_URL}/user_data/summary/user`);
export const getUserWordSkillsUser = (language) => get(`${API_URL}/user_data/word_skills/user/${language}`);
export const resetUserWordSkills = () => post(`${API_URL}/words/word-skills/reset`, {});