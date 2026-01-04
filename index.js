// @ts-nocheck
import { characters, eventSource, event_types, saveSettingsDebounced, this_chid, chat } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { selected_group } from "../../../group-chats.js";

const MODULE_NAME = 'Asset-tracker';

const ASSET_PATTERNS = [
    /\{\{img::(.*?)\}\}/gi,
    /<img\s+[^>]*src=["']([^"']+)["']/gi
];

// 정규식: 등호 주변 공백 허용, 따옴표 안의 내용 추출
const CUSTOM_MSG_REGEX = /asset_complete\s*=\s*(["'])([\s\S]*?)\1/i;

const TRACKER_LIST_ID = '#tracker_assets_list';
const ORIGINAL_LIST_ID = '#character_assets_list';
const RESET_BTN_ID = '#tracker_reset_btn';

function initializeSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].characterAssets) extension_settings[MODULE_NAME].characterAssets = {};
}

function getCurrentCharacter() {
    const context = getContext();
    if (selected_group) return null; 
    return characters[this_chid];
}

function initializeCharacterAssets(characterId) {
    if (!extension_settings[MODULE_NAME].characterAssets[characterId]) {
        extension_settings[MODULE_NAME].characterAssets[characterId] = { enabled: true, unlocked: [] };
    }
    if (!Array.isArray(extension_settings[MODULE_NAME].characterAssets[characterId].unlocked)) {
        extension_settings[MODULE_NAME].characterAssets[characterId].unlocked = [];
    }
}

function getCharacterAssets(characterId) {
    initializeCharacterAssets(characterId);
    return extension_settings[MODULE_NAME].characterAssets[characterId];
}

function isCharacterAssetsEnabled(characterId) {
    if (!extension_settings[MODULE_NAME]?.characterAssets?.[characterId]) return false; 
    return extension_settings[MODULE_NAME].characterAssets[characterId].enabled;
}

async function fetchCharacterAssets(characterName) {
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(characterName)}`);
        if (!result.ok) return [];
        return await result.json();
    } catch (error) {
        console.error(`[${MODULE_NAME}] 에셋 목록 가져오기 실패:`, error);
        return [];
    }
}

function extractFileNames(text) {
    if (!text || typeof text !== 'string') return [];

    const foundFiles = new Set();
    ASSET_PATTERNS.forEach(regex => {
        const cleanRegex = new RegExp(regex);
        const matches = [...text.matchAll(cleanRegex)];
        for (const match of matches) {
            if (match[1]) {
                foundFiles.add(match[1].trim());
            }
        }
    });
    return Array.from(foundFiles);
}

/**
 * [강화됨] 커스텀 메시지 찾기
 * 설명: 설명창, 제작자 노트, 첫 메시지, 월드인포, 그리고 '작가 노트(Author's Note)'까지 뒤집니다.
 */
function findCustomCompletionMessage() {
    const character = getCurrentCharacter();
    if (!character) return null;

    // 1. 제작자 노트 (Creator's Notes) - 추천 1순위
    const creatorNotes = character.creator_notes || character.creatorcomment || "";

    // 2. 작가 노트 (Author's Note) - 추천 2순위
    // 실리태번 데이터 구조상 data.depth_prompt_prompt 또는 extensions.depth_prompt 등에 위치함
    const authorsNote = character.data?.depth_prompt_prompt || character.data?.extensions?.depth_prompt?.prompt || "";

    const searchTargets = [
        character.description, // 설명
        creatorNotes,          // 제작자 노트
        authorsNote,           // 작가 노트 (A 아이콘)
        character.first_mes    // 첫 메시지
    ];

    // 3. 월드인포 (World Info)
    const context = getContext();
    if (context && context.worldInfo && Array.isArray(context.worldInfo)) {
        context.worldInfo.forEach(entry => {
            if (entry.content) searchTargets.push(entry.content);
        });
    }

    // 4. 전체 검색
    for (const text of searchTargets) {
        if (!text || typeof text !== 'string') continue;
        
        const match = text.match(CUSTOM_MSG_REGEX);
        // match[2]가 따옴표 안의 내용
        if (match && match[2]) {
            return match[2]; 
        }
    }

    return null;
}

async function checkCompletionAndNotify(characterId) {
    const character = getCurrentCharacter();
    if (!character) return;

    const charName = character.avatar.replace(/\.[^/.]+$/, '');
    const allAssets = await fetchCharacterAssets(charName);
    
    // [중요] 반드시 현재 메모리 상태(getCharacterAssets)를 가져와서 비교
    const myAssets = getCharacterAssets(characterId).unlocked;

    if (allAssets.length === 0) return;

    // 100% 달성 체크
    if (myAssets.length >= allAssets.length) {
        const customMsg = findCustomCompletionMessage();
        
        const toastOptions = { 
            timeOut: 10000,         // 10초 유지
            extendedTimeOut: 5000,
            tapToDismiss: true,     // 클릭 닫기
            closeButton: true,
            positionClass: "toast-top-center"
        };

        if (customMsg) {
            showToast('info', customMsg, '🏆 히든 메시지 발견!', toastOptions);
        } else {
            showToast('info', `모든 애셋(${allAssets.length}개)을 수집했습니다!`, '🏆 100% 달성 축하합니다!', toastOptions);
        }
    }
}

async function scanChatHistory() {
    if (!chat || !Array.isArray(chat) || !getCurrentCharacter()) return;

    const charId = String(this_chid);
    const assetsData = getCharacterAssets(charId);
    let isUpdated = false;

    const aiMessages = chat.filter(msg => !msg.is_user);
    const recentAiMessages = aiMessages.slice(-10);

    recentAiMessages.forEach(msg => {
        if (!msg.mes) return; 
        const foundFiles = extractFileNames(msg.mes);
        foundFiles.forEach(fileName => {
            if (!assetsData.unlocked.includes(fileName)) {
                assetsData.unlocked.push(fileName);
                isUpdated = true;
            }
        });
    });

    if (isUpdated) {
        saveSettingsDebounced();
        // 메모리 업데이트 후 즉시 화면 갱신
        await loadCharacterAssets();
        await checkCompletionAndNotify(charId);
    }
}

async function loadCharacterAssets() {
    const character = getCurrentCharacter();
    const assetsListContainer = $(TRACKER_LIST_ID);

    if (assetsListContainer.length === 0) return;

    if (!character) {
        assetsListContainer.html('<div style="padding:20px; text-align:center; color:gray;">캐릭터를 선택해주세요.</div>');
        return;
    }

    if (assetsListContainer.children().length === 0) {
        assetsListContainer.html('<div style="padding:20px; text-align:center;">동기화 중...</div>');
    }

    const charName = character.avatar.replace(/\.[^/.]+$/, '');
    const assets = await fetchCharacterAssets(charName);
    const savedData = getCharacterAssets(String(this_chid));
    const unlockedList = savedData.unlocked || [];

    assetsListContainer.empty();

    if (assets.length === 0) {
        assetsListContainer.html('<div style="padding:10px; opacity:0.7;">이 캐릭터는 연결된 애셋 파일이 없습니다.</div>');
        return;
    }

    let unlockedCount = 0;
    const totalCount = assets.length;
    assets.sort((a, b) => a.path.localeCompare(b.path));

    assets.forEach(asset => {
        const fullFileName = asset.path.split('/').pop().split('?')[0];
        const isUnlocked = unlockedList.includes(fullFileName);
        
        if (isUnlocked) unlockedCount++;

        const statusClass = isUnlocked ? 'unlocked' : 'locked';
        const icon = isUnlocked ? '✅' : '🔒';

        const itemHtml = `
            <div class="asset-item ${statusClass}">
                <span class="asset-icon">${icon}</span>
                <span class="asset-name">${fullFileName}</span>
            </div>
        `;
        assetsListContainer.append(itemHtml);
    });

    const percent = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
    const statsHtml = `
        <div class="asset-stats-box">
            📊 해금 현황: ${unlockedCount} / ${totalCount} (${percent}%)
        </div>
    `;
    assetsListContainer.append(statsHtml);
}

// 리셋 버튼 핸들러
async function handleResetProgress() {
    const character = getCurrentCharacter();
    if (!character) return;

    const confirmed = confirm("⚠️ 경고: 현재 캐릭터의 모든 애셋 해금 기록을 초기화하시겠습니까?\n이 작업은 되돌릴 수 없습니다.");
    if (!confirmed) return;

    const charId = String(this_chid);
    const assetsData = getCharacterAssets(charId);
    
    assetsData.unlocked = [];
    saveSettingsDebounced();
    
    await loadCharacterAssets();
    
    showToast('info', '모든 진행도가 초기화되었습니다.', '초기화 완료');
}

async function onCharacterChanged() {
    const character = getCurrentCharacter();
    if (!character) {
        // 캐릭터가 없어도 리스트 박스를 찾아 "선택해주세요" 메시지를 띄움
        await loadCharacterAssets();
        return;
    }
    
    initializeCharacterAssets(String(this_chid));
    setupOriginalExtensionSpy();
    scanChatHistory();
    await loadCharacterAssets();
}

async function onMessageReceived(data) {
    const charId = String(this_chid);
    if (!isCharacterAssetsEnabled(charId)) return;
    if (!data) return;

    const messageContent = data.message || data.mes;
    if (!messageContent) return;

    const foundFiles = extractFileNames(messageContent);
    if (foundFiles.length === 0) return;

    // [핵심] 메모리 데이터 즉시 수정
    const assetsData = getCharacterAssets(charId);
    let isUpdated = false;

    foundFiles.forEach(fileName => {
        if (!assetsData.unlocked.includes(fileName)) {
            assetsData.unlocked.push(fileName);
            isUpdated = true;
        }
    });

    if (isUpdated) {
        // 1. 디스크 저장은 천천히 하라고 던져둠
        saveSettingsDebounced();

        // 2. 화면 갱신과 축하 메시지는 '지금 당장' 실행
        // (저장 완료를 기다리지 않으므로 즉시 반영됨)
        if (getCurrentCharacter()) {
            await loadCharacterAssets();
            await checkCompletionAndNotify(charId);
        }
    }
}

let mutationObserver = null;

function setupOriginalExtensionSpy() {
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    const targetNode = document.querySelector(ORIGINAL_LIST_ID);
    if (!targetNode) return;

    mutationObserver = new MutationObserver((mutationsList) => {
        loadCharacterAssets();
    });

    mutationObserver.observe(targetNode, { childList: true, subtree: true });
}

function showToast(type, message, title = '', customOptions = {}) {
    if (window.toastr) {
        const defaultOptions = { 
            preventDuplicates: true, 
            timeOut: 3000, 
            positionClass: "toast-top-center" 
        };
        const finalOptions = { ...defaultOptions, ...customOptions };
        window.toastr[type](message, title, finalOptions);
    } else {
        console.log(`[${type.toUpperCase()}] ${title}: ${message}`);
    }
}

function setupEventHandlers() {
    $(document).on('click', RESET_BTN_ID, handleResetProgress);
}

// [핵심] 로딩 전략: 리스트 박스가 생길 때까지 집요하게 확인 (Polling)
function initializeExtension() {
    console.log(`[${MODULE_NAME}] 초기화 시작...`);
    initializeSettings();

    // 1. settings.html 로드
    $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`)
        .then(html => {
            $('#extensions_settings').append(html);
        })
        .catch(error => console.error(`[${MODULE_NAME}] HTML 로드 실패:`, error));

    setupEventHandlers();
    
    // 2. DOM 감지 (독종 모드)
    // 0.1초마다 확인하다가, 리스트 박스(#tracker_assets_list)가 생기면 즉시 실행하고 종료
    const initInterval = setInterval(async () => {
        const listContainer = $(TRACKER_LIST_ID);
        if (listContainer.length > 0) {
            clearInterval(initInterval); // 찾았으니 감시 종료
            console.log(`[${MODULE_NAME}] UI 발견됨. 동기화 시작.`);
            await onCharacterChanged();
        }
    }, 100);

    // 이벤트 리스너 연결
    eventSource.on(event_types.CHAT_CHANGED, onCharacterChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    
    // MutationObserver로 재연결 대비
    const observerCallback = new MutationObserver(() => {
        setupOriginalExtensionSpy();
    });
    const extensionsPanel = document.querySelector('#extensions_settings');
    if (extensionsPanel) {
        observerCallback.observe(extensionsPanel, { childList: true, subtree: true });
    }

    console.log(`[${MODULE_NAME}] 초기화 로직 완료.`);
}

$(document).ready(function() {
    initializeExtension();
});