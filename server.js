require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================
// 🌐 [온라인 매치 전용] Express 서버를 WebSocket 하이브리드로 변환
// =================================================================
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// 👥 실시간 온라인 매칭을 제어하기 위한 전역 데이터 저장소
let waitingPlayers = [];
let activeRooms = {};

// 🔀 [공용 셔플 헬퍼] Fisher-Yates 셔플 후, 텐구(id 403)가 덱 안에 들어있다면 항상 맨 위(0번)로
// 재배치한다. 텐구는 "아무도 안 뽑으면 다음 라운드 마켓에 무조건 포함"되어야 하는 카드라서,
// 무덤을 덱에 합쳐 셔플하는 모든 지점(마켓 리프레시/카드 드로우/라운드 종료)에서 이 보장이
// 무작위 셔플로 깨지지 않도록 셔플 직후 텐구만 따로 맨 앞으로 꽂아준다.
function shuffleDeckPreservingTengu(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    const tenguIdx = deck.findIndex(c => c && (c.id === 403 || c.name === "텐구"));
    if (tenguIdx > 0) {
        const [tengu] = deck.splice(tenguIdx, 1);
        deck.unshift(tengu);
    }
}

// ⏱️ [라운드 단계별 타이머] 찜(드래프트) 60초 / 액션 120초 / 환기 60초.
// 시간이 다 되면 정상 흐름과 똑같은 "전원 완료" 처리 함수를 강제로 호출해 다음 단계로 넘긴다.
const PHASE_DURATIONS = { ARTIFACT_DRAFT: 30000, DRAFT: 60000, ACTION: 120000, REFRESH: 60000 };

function startPhaseTimer(roomID, phase) {
    const room = activeRooms[roomID];
    if (!room) return;
    if (room.phaseTimerHandle) {
        clearTimeout(room.phaseTimerHandle);
        room.phaseTimerHandle = null;
    }
    room.currentServerPhase = phase;
    const durationMs = PHASE_DURATIONS[phase];
    room.phaseTimerStartedAt = Date.now();
    room.phaseTimerDurationMs = durationMs;

    io.to(roomID).emit('phaseTimerStart', { phase, durationMs });

    room.phaseTimerHandle = setTimeout(() => {
        const r = activeRooms[roomID];
        if (!r || r.currentServerPhase !== phase) return;
        if (phase === 'ARTIFACT_DRAFT') forceEndCurrentArtifactPick(roomID);
        else if (phase === 'DRAFT') forceEndCurrentPlayerDraftTurn(roomID);
        else if (phase === 'ACTION') forceEndCurrentPlayerActionTurn(roomID);
        else if (phase === 'REFRESH') forceEndCurrentPlayerRefreshTurn(roomID);
    }, durationMs);
}

// 🐍 [스네이크 드래프트] 인원수에 따라 동적으로 스네이크 순서 생성 (2~4인 지원)
// 예: 2인=[0,1,1,0], 3인=[0,1,2,2,1,0], 4인=[0,1,2,3,3,2,1,0]
function generateSnakeDraftSequence(numPlayers) {
    const forward = Array.from({ length: numPlayers }, (_, i) => i);
    return [...forward, ...forward.slice().reverse()];
}

// ⚗️ [아티팩츠 확장] 유물 타일 11종 정의 (그룹 1~4)
const ARTIFACT_TILES = [
    { id: 'grimoire', nameKo: '토트의 고서',  group: 1, type: 'action',     emoji: '📖', desc: '보유 마법석 중 최대 2개를 각 1단계 승급' },
    { id: 'helm',     nameKo: '하데스의 투구', group: 1, type: 'action',     emoji: '⛑️', desc: '더미에서 1장 포획 + 영역토큰 1단계 또는 6원 1개 획득' },
    { id: 'jewel',    nameKo: '쿠쿨칸의 보석', group: 1, type: 'continuous', emoji: '💎', desc: '카드 판매 직후 1원 내면 그 카드를 손에 넣음 (1회성 옵션)' },
    { id: 'seal',     nameKo: '제왕의 인장',   group: 1, type: 'action',     emoji: '🔏', desc: '자기 영역 카드 1장 버리기 → 드래곤 계열이면 3원 1개 획득' },
    { id: 'philo',    nameKo: '현자의 돌',     group: 1, type: 'instant',    emoji: '🪨', desc: '포획한 카드 중 1장 손에 추가, 다른 1장 버리고 6원 획득 가능' },
    { id: 'ring',     nameKo: '소원의 반지',   group: 1, type: 'action',     emoji: '💍', desc: '자기 영역의 환기 효과 1개를 즉시 발동' },
    { id: 'censer',   nameKo: '신비한 향로',   group: 2, type: 'action',     emoji: '🏺', desc: '3원 내고 영역토큰 1단계 상승 또는 더미에서 2장 포획' },
    { id: 'ruyi',     nameKo: '여의봉',        group: 2, type: 'action',     emoji: '🪄', desc: '손에서 카드 2장 버리고 1원+1원+3원+6원 획득' },
    { id: 'flute',    nameKo: '마술피리',      group: 2, type: 'instant',    emoji: '🎵', desc: '카드 1장 뽑기 또는 포획한 카드 전부 손에 넣기' },
    { id: 'boots',    nameKo: '마법 장화',     group: 3, type: 'action',     emoji: '👢', desc: '카드 1장 더 공개하고 그중 1장 포획' },
    { id: 'fleece',   nameKo: '황금 양털',     group: 4, type: 'action',     emoji: '🌿', desc: '1원 2개 획득 + (더미에서 1장 포획 또는 포획카드 1장을 손에 추가)' },
];

function setupArtifactSupply(numPlayers) {
    const g1 = ARTIFACT_TILES.filter(t => t.group === 1).sort(() => Math.random() - 0.5).slice(0, 3);
    const g2 = numPlayers >= 3 ? ARTIFACT_TILES.filter(t => t.group === 2) : [];
    const g3 = numPlayers >= 3 ? ARTIFACT_TILES.filter(t => t.group === 3) : [];
    const g4 = numPlayers >= 4 ? ARTIFACT_TILES.filter(t => t.group === 4) : [];
    return [...g1, ...g2, ...g3, ...g4].map(t => ({ ...t, claimedBy: null }));
}

// ⚗️ [유물 드래프트 시작] 라운드 시작 시 카드 드래프트보다 먼저 진행
function startArtifactDraftPhase(roomID) {
    const room = activeRooms[roomID];
    if (!room) return;
    room.currentArtifactSelectorIdx = 0;
    // 유물 공급 클리어 (라운드 시작마다 초기화)
    room.artifactSupply.forEach(a => { a.claimedBy = null; });
    const selector = room.turnSequence[0];
    io.to(roomID).emit('artifactDraftStart', {
        artifactSupply: room.artifactSupply,
        currentSelectorID: selector.id,
        currentSelectorNickname: selector.nickname,
        lastRoundRestrictions: room.lastRoundArtifactByPlayer || {}
    });
    startPhaseTimer(roomID, 'ARTIFACT_DRAFT');
}

// ⚗️ [유물 드래프트 종료 → 카드 드래프트 시작]
function startCardDraftPhase(roomID) {
    const room = activeRooms[roomID];
    if (!room) return;
    room.currentDraftStep = 0;
    room.currentTurnOwnerIndex = 0;
    const snakeSeq = room.snakeDraftSequence || generateSnakeDraftSequence(room.turnSequence.length);
    const firstDraftPlayer = room.turnSequence[snakeSeq[0]];
    io.to(roomID).emit('artifactDraftComplete', {
        artifactSupply: room.artifactSupply,
        playerArtifacts: room.artifactSupply.filter(a => a.claimedBy)
    });
    io.to(roomID).emit('draftTurnStart', {
        currentTurnOwnerID: firstDraftPlayer.id,
        currentTurnOwnerNickname: firstDraftPlayer.nickname,
        logMessage: `🎲 [카드 드래프트 1/${snakeSeq.length}] 첫 번째 드래프터: [ ${firstDraftPlayer.nickname} ] (60초)`
    });
    startPhaseTimer(roomID, 'DRAFT');
}

// ⚗️ [유물 드래프트 타임아웃] 현재 선택자가 30초 안에 못 고르면 자동 배정
function forceEndCurrentArtifactPick(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.currentServerPhase !== 'ARTIFACT_DRAFT') return;
    const selector = room.turnSequence[room.currentArtifactSelectorIdx];
    if (selector) {
        const alreadyPicked = room.artifactSupply.find(a => a.claimedBy === selector.nickname);
        if (!alreadyPicked) {
            const lastId = (room.lastRoundArtifactByPlayer || {})[selector.nickname];
            const available = room.artifactSupply.filter(a => !a.claimedBy && a.id !== lastId);
            const pool = available.length > 0 ? available : room.artifactSupply.filter(a => !a.claimedBy);
            if (pool.length > 0) {
                const picked = pool[Math.floor(Math.random() * pool.length)];
                picked.claimedBy = selector.nickname;
                if (!room.lastRoundArtifactByPlayer) room.lastRoundArtifactByPlayer = {};
                room.lastRoundArtifactByPlayer[selector.nickname] = picked.id;
                io.to(roomID).emit('artifactDraftUpdate', {
                    artifactSupply: room.artifactSupply,
                    pickerNickname: selector.nickname,
                    artifactId: picked.id,
                    autoAssigned: true
                });
            }
        }
    }
    room.currentArtifactSelectorIdx++;
    if (room.currentArtifactSelectorIdx >= room.turnSequence.length) {
        startCardDraftPhase(roomID);
    } else {
        const next = room.turnSequence[room.currentArtifactSelectorIdx];
        io.to(roomID).emit('artifactDraftNext', {
            currentSelectorID: next.id,
            currentSelectorNickname: next.nickname,
            lastRoundRestrictions: room.lastRoundArtifactByPlayer || {}
        });
        startPhaseTimer(roomID, 'ARTIFACT_DRAFT');
    }
}

// ⏰ [강제 마감 - 드래프트 인당] 현재 픽이 끝나면(찜 완료 or 60초 만료 or 완료 버튼) 호출된다.
// 6픽을 다 소진하면 액션 단계로 전환, 아니면 다음 픽 플레이어에게 새 60초 타이머를 시작한다.
function forceEndCurrentPlayerDraftTurn(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    // 현재 차례 플레이어가 아무 카드도 찜하지 않은 경우 랜덤 자동 배정
    const currentPlayer = room.turnSequence[room.currentTurnOwnerIndex];
    if (currentPlayer) {
        const hasClaim = room.marketCards.some(c => c.claimedBy === currentPlayer.nickname);
        if (!hasClaim) {
            const available = room.marketCards.filter(c => !c.claimedBy);
            if (available.length > 0) {
                const picked = available[Math.floor(Math.random() * available.length)];
                picked.claimedBy = currentPlayer.nickname;
                if (typeof room.markersPlaced === 'undefined') room.markersPlaced = 0;
                room.markersPlaced++;
                console.log(`🎲 [자동 찜] [${roomID}] 시간 초과 → ${currentPlayer.nickname}에게 [${picked.name}] 자동 배정`);
                io.to(roomID).emit('sync_marketUpdate', {
                    marketCards: room.marketCards,
                    pickerNickname: currentPlayer.nickname,
                    cardName: picked.name,
                    serverMarkersPlaced: room.markersPlaced,
                    autoAssigned: true
                });
            }
        }
    }

    if (typeof room.currentDraftStep === 'undefined') room.currentDraftStep = 0;
    room.currentDraftStep++;

    const snakeSeq = room.snakeDraftSequence || generateSnakeDraftSequence(room.turnSequence.length);
    if (room.currentDraftStep >= snakeSeq.length) {
        room.currentTurnOwnerIndex = 0;
        const firstActionPlayer = room.turnSequence[0];
        io.to(roomID).emit('draftPhaseEnded', {
            marketCards: room.marketCards,
            firstActionPlayerID: firstActionPlayer.id,
            firstActionPlayerNickname: firstActionPlayer.nickname,
            logMessage: `🎲 모든 플레이어의 드래프트가 완료되었습니다. 액션 단계로 넘어갑니다!`
        });
        startPhaseTimer(roomID, 'ACTION');
    } else {
        const nextOwnerIdx = snakeSeq[room.currentDraftStep];
        room.currentTurnOwnerIndex = nextOwnerIdx;
        const nextPlayer = room.turnSequence[nextOwnerIdx];

        io.to(roomID).emit('draftTurnStart', {
            currentTurnOwnerID: nextPlayer.id,
            currentTurnOwnerNickname: nextPlayer.nickname,
            logMessage: `🎲 [드래프트 ${room.currentDraftStep + 1}/${snakeSeq.length}] [ ${nextPlayer.nickname} ] 님 차례입니다. (60초)`
        });
        startPhaseTimer(roomID, 'DRAFT');
    }
}

// ⏰ [강제 마감 - 액션 인당] 현재 플레이어의 120초가 만료되면 해당 플레이어의 턴을 강제로 넘긴다.
// 마지막 플레이어면 환기 단계로 전환, 아니면 다음 플레이어에게 새 120초 타이머를 시작한다.
function forceEndCurrentPlayerActionTurn(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    if (!room.actionFinishedCount) room.actionFinishedCount = 0;
    const currentTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];
    room.actionFinishedCount++;

    if (room.actionFinishedCount >= room.turnSequence.length) {
        finishActionPhase(roomID, `⏰ [시간 종료] ${currentTurnPlayer.nickname}님의 120초가 지나 액션 단계가 종료됩니다.`);
    } else {
        room.currentTurnOwnerIndex = (room.currentTurnOwnerIndex + 1) % room.turnSequence.length;
        const nextTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];

        io.to(roomID).emit('sync_turnUpdate', {
            currentTurnOwnerID: nextTurnPlayer.id,
            currentTurnOwnerNickname: nextTurnPlayer.nickname,
            marketCards: room.marketCards,
            logMessage: `⏰ [시간 종료] ${currentTurnPlayer.nickname}님의 120초가 지나 턴이 강제로 넘어갑니다. 다음 차례: [ ${nextTurnPlayer.nickname} ]`
        });

        startPhaseTimer(roomID, 'ACTION');
    }
}

// ⏰ [강제 마감 - 환기 인당] 현재 플레이어의 60초가 만료되면 해당 플레이어의 환기 턴을 강제로 넘긴다.
// 마지막 플레이어면 라운드 마감 판정, 아니면 다음 플레이어에게 새 60초 타이머를 시작한다.
function forceEndCurrentPlayerRefreshTurn(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    if (!room.refreshFinishedPlayers) room.refreshFinishedPlayers = [];
    const currentTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];

    if (!room.refreshFinishedPlayers.includes(currentTurnPlayer.id)) {
        room.refreshFinishedPlayers.push(currentTurnPlayer.id);
    }

    if (room.refreshFinishedPlayers.length >= room.players.length) {
        finishRefreshPhaseAndContinue(roomID);
    } else {
        room.currentTurnOwnerIndex = (room.currentTurnOwnerIndex + 1) % room.turnSequence.length;
        const nextTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];

        io.to(roomID).emit('sync_turnUpdate', {
            currentTurnOwnerID: nextTurnPlayer.id,
            currentTurnOwnerNickname: nextTurnPlayer.nickname,
            marketCards: room.marketCards,
            logMessage: `⏰ [시간 종료] ${currentTurnPlayer.nickname}님의 60초가 지나 환기 턴이 강제로 넘어갑니다. 다음 차례: [ ${nextTurnPlayer.nickname} ]`
        });

        startPhaseTimer(roomID, 'REFRESH');
    }
}

// 🔄 [액션 단계 마감] 전원이 턴을 끝냈을 때(자연 종료) 또는 120초가 지났을 때(강제 종료) 공통으로 호출되어 환기 단계를 연다.
function finishActionPhase(roomID, logMessageOverride) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    room.actionFinishedCount = 0;
    room.currentTurnOwnerIndex = 0;
    const absoluteLeader = room.turnSequence[0];

    io.to(roomID).emit('sync_startRefreshPhase', {
        currentTurnOwnerID: absoluteLeader.id,
        currentTurnOwnerNickname: absoluteLeader.nickname,
        marketCards: room.marketCards,
        logMessage: logMessageOverride || `🔄 [페이즈 전환] 전원 행동 완료! 환기 단계가 개시됩니다. 선플레이어 [ ${absoluteLeader.nickname} ] 님부터 효과 정산을 시작하세요.`
    });

    startPhaseTimer(roomID, 'REFRESH');
}

// 🚀 [라운드 전환] 전원이 환기를 끝냈을 때(자연 종료) 또는 60초가 지났을 때(강제 종료) 공통으로 호출되어 다음 라운드를 연다.
function advanceToNextRound(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    room.refreshFinishedPlayers = [];
    room.currentRound += 1;
    room.markersPlaced = 0;

    const shiftedSequence = [...room.turnSequence];
    const firstPlayer = shiftedSequence.shift();
    shiftedSequence.push(firstPlayer);

    room.turnSequence = shiftedSequence.map((player, idx) => {
        player.turnIndex = idx;
        return player;
    });

    room.currentTurnOwnerIndex = 0;

    const numPlayers = room.turnSequence.length;
    const marketSize = numPlayers * 2;

    let nextMarketCards = [];
    if (room.gameMainDeck.length < marketSize) {
        if (room.discardPile && room.discardPile.length > 0) {
            room.gameMainDeck = [...room.gameMainDeck, ...room.discardPile];
            room.discardPile = [];
            shuffleDeckPreservingTengu(room.gameMainDeck);
        }
    }

    for (let i = 0; i < marketSize; i++) {
        if (room.gameMainDeck.length > 0) {
            nextMarketCards.push(room.gameMainDeck.shift());
        }
    }
    room.marketCards = nextMarketCards;

    room.currentDraftStep = 0;
    room.currentTurnOwnerIndex = 0;

    io.to(roomID).emit('nextRoundStarted', {
        nextRound: room.currentRound,
        nextMarketCards: room.marketCards,
        turnSequence: room.turnSequence
    });

    // 확장판이면 유물 드래프트 먼저, 기본판이면 카드 드래프트 바로 시작
    if (room.expansions && room.expansions.artifacts && room.artifactSupply && room.artifactSupply.length > 0) {
        startArtifactDraftPhase(roomID);
    } else {
        const firstDraftPlayer = room.turnSequence[0];
        io.to(roomID).emit('draftTurnStart', {
            currentTurnOwnerID: firstDraftPlayer.id,
            currentTurnOwnerNickname: firstDraftPlayer.nickname,
            logMessage: `🎲 [드래프트 1/${marketSize}] 첫 번째 드래프터: [ ${firstDraftPlayer.nickname} ] (60초)`
        });
        startPhaseTimer(roomID, 'DRAFT');
    }
}

// 🏆 [라운드 종료 시점 점수 집계] 이번 라운드에 환기 정산을 마치며 보낸 점수/전장 카드 수를 모은다.
// 타임아웃으로 강제 마감된 경우엔 보내지 못한 플레이어도 있을 수 있어서, 그런 경우엔
// 직전 액션 단계에서 기억해둔 rivalsMemory 값으로 대체한다.
function getRoundEndScores(room) {
    return room.players.map(player => {
        const submitted = room.finalScoresThisRound && room.finalScoresThisRound[player.id];
        if (submitted) return submitted;

        const remembered = room.rivalsMemory && room.rivalsMemory[player.nickname];
        return {
            nickname: player.nickname,
            score: remembered ? (remembered.score || 0) : 0,
            summonZoneCount: remembered && remembered.summonZone ? remembered.summonZone.length : 0
        };
    });
}

// 🏆 [게임 종료] 10라운드를 다 마쳤거나 누군가 60점에 도달한 라운드가 끝났을 때 호출된다.
// 동점이면 전장에 소환된 카드가 더 많은 사람이 승리, 그것도 같으면 공동 우승.
function endGame(roomID, scoresSnapshot) {
    const room = activeRooms[roomID];
    if (!room) return;

    if (room.phaseTimerHandle) {
        clearTimeout(room.phaseTimerHandle);
        room.phaseTimerHandle = null;
    }
    room.currentServerPhase = 'GAME_OVER';

    const maxScore = Math.max(...scoresSnapshot.map(p => p.score));
    const topByScore = scoresSnapshot.filter(p => p.score === maxScore);

    let winners = topByScore;
    if (topByScore.length > 1) {
        const maxSummonCount = Math.max(...topByScore.map(p => p.summonZoneCount));
        winners = topByScore.filter(p => p.summonZoneCount === maxSummonCount);
    }

    const standings = [...scoresSnapshot].sort((a, b) => b.score - a.score || b.summonZoneCount - a.summonZoneCount);

    io.to(roomID).emit('gameOver', {
        finalRound: room.currentRound,
        standings,
        winners: winners.map(w => w.nickname)
    });
}

// 🔄 [라운드 마감 판정] 환기 정산이 끝날 때마다(자연/강제 모두) 여기를 거쳐서
// 게임을 끝낼지(10라운드 종료 또는 60점 달성), 다음 라운드로 넘길지를 정한다.
function finishRefreshPhaseAndContinue(roomID) {
    const room = activeRooms[roomID];
    if (!room || room.turnSequence.length === 0) return;

    const scoresSnapshot = getRoundEndScores(room);
    room.finalScoresThisRound = {};

    // 아티팩츠 확장 활성 시 종료 점수 80점, 기본 60점
    const winScore = (room.expansions && room.expansions.artifacts) ? 80 : 60;
    const reachedScoreLimit = scoresSnapshot.some(p => p.score >= winScore);
    const isLastRound = room.currentRound >= 10;

    // 환기 단계 끝 — 유물 타일 공급처 복귀 (마커 정보는 lastRoundArtifactByPlayer에 유지)
    if (room.artifactSupply) {
        room.artifactSupply.forEach(a => { a.claimedBy = null; });
        io.to(roomID).emit('artifactsReturned', { artifactSupply: room.artifactSupply });
    }

    if (reachedScoreLimit || isLastRound) {
        endGame(roomID, scoresSnapshot);
    } else {
        advanceToNextRound(roomID);
    }
}

// 서버 설정
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); 

// 🌟 MongoDB Atlas 주소 - .env 파일의 DB_URL 환경변수에서 읽어온다 (배포 시엔 호스팅 서비스의 환경변수로 설정)
const DB_URL = process.env.DB_URL;
if (!DB_URL) {
    console.error("❌ DB_URL 환경변수가 설정되지 않았습니다. .env 파일을 확인하세요.");
    process.exit(1);
}

// 🌀 데이터베이스 연결
mongoose.connect(DB_URL)
  .then(() => {
    console.log("✨ 테이머 연합 데이터베이스 연결 성공!");
    initializeCardDatabase();
  })
  .catch(err => console.error("❌ 데이터베이스 연결 실패:", err));

// 📝 [DB 스키카 설정] 유저 및 카드 구조
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    nickname: { type: String, required: true }
});
const User = mongoose.model('User', userSchema);

const cardSchema = new mongoose.Schema({
    id: Number,
    name: String,
    type: String,
    cost: Number,
    timing: String,
    summary: String,
    effect: { action: String, stoneType: String, count: Number, value: Number }
});
const Card = mongoose.model('Card', cardSchema);

// 🎲 서버 시작 시 실제 5대 속성 카드 데이터 70종 최종 강제 주입 함수
async function initializeCardDatabase() {
    try {
        await Card.deleteMany({}); 
        const realCards = [
            // ================= 🔥 불 속성 15장 (101 ~ 115) =================
            { id: 101, name: "헤스티아", type: "🔥 PASSIVE", cost: 0, timing: "passive", summary: "마법석 최대 보유량 +2", effect: { action: "hestia" } },
            { id: 102, name: "임프", type: "🔥 INSTANT / REFRESH", cost: 0, timing: "both", summary: "즉발: 🔴 2개 획득 / 환기: 손패로 귀환", effect: { action: "imp" } },
            { id: 103, name: "서큐버스", type: "🔥 INSTANT", cost: 0, timing: "instant", summary: "1,2,3,4코스트 전부 소환 시 +10점", effect: { action: "succubus" } },
            { id: 104, name: "살라만더", type: "🔥 REFRESH", cost: 1, timing: "refresh", summary: "환기: 🔴 마법석 1개와 승점 1점을 얻습니다.", effect: { action: "salamander" } },
            { id: 105, name: "불여우", type: "🔥 INSTANT", cost: 1, timing: "instant", summary: "당신의 손에 든 카드 1장마다 1점을 얻습니다.", effect: { action: "fire_fox" } },
            { id: 106, name: "이프리트", type: "🔥 INSTANT", cost: 2, timing: "instant", summary: "소환되어 있는 당신의 카드 1장마다 1점을 얻습니다.", effect: { action: "ifrit" } },
            { id: 107, name: "인큐버스", type: "🔥 INSTANT", cost: 2, timing: "instant", summary: "소환된 2코 이하 카드 1장마다 2점을 얻습니다.", effect: { action: "incubus" } },
            { id: 108, name: "상급 살라만더", type: "🔥 REFRESH", cost: 2, timing: "refresh", summary: "환기: 1코스트(🔴) 마법석 4개를 얻습니다.", effect: { action: "high_salamander" } },
            { id: 109, name: "불타는 해골", type: "🔥 REFRESH", cost: 3, timing: "refresh", summary: "환기: 보유한 🔴 1개를 버리면 승점 3점을 얻습니다.", effect: { action: "burning_skull" } },
            { id: 110, name: "용암거인", type: "🔥 INSTANT", cost: 3, timing: "instant", summary: "소환되어 있는 불 속성 카드 1장마다 2점을 얻습니다.", effect: { action: "lava_giant" } },
            { id: 111, name: "피닉스", type: "🔥 PASSIVE", cost: 3, timing: "passive", summary: "지속: 다른 카드 소환 시 지불한 🔴 1개당 승점 1점", effect: { action: "phoenix" } },
            { id: 112, name: "아스모데우스", type: "🔥 REFRESH", cost: 4, timing: "refresh", summary: "환기: 2코 이하 즉발 카드 1장을 손으로 귀환", effect: { action: "asmodeus" } },
            { id: 113, name: "수르트", type: "🔥 INSTANT", cost: 4, timing: "instant", summary: "소환되어 있는 당신의 카드 계열(속성)마다 2점 획득", effect: { action: "surt" } },
            { id: 114, name: "발로그", type: "🔥 REFRESH", cost: 4, timing: "refresh", summary: "환기: 즉발 효과를 가진 불 속성 카드 1장 손패 귀환", effect: { action: "balrog" } },
            { id: 115, name: "아그니", type: "🔥 PASSIVE", cost: 4, timing: "passive", summary: "지속: 당신의 1코스트(🔴) 마법석의 가치가 1 상승", effect: { action: "agni" } },

            // ================= 💧 물 속성 15장 (201 ~ 215) =================
            { id: 201, name: "설녀", type: "💧 INSTANT", cost: 0, timing: "instant", summary: "즉발: 보유한 모든 마법석을 버리고 그 가치만큼 점수 획득", effect: { action: "yuki_onna" } },
            { id: 202, name: "바다 정령", type: "💧 REFRESH", cost: 1, timing: "refresh", summary: "환기: 보유한 3코스트(🔵) 마법석 1개당 승점 1점 획득", effect: { action: "sea_spirit" } },
            { id: 203, name: "운디네", type: "💧 INSTANT / REFRESH", cost: 1, timing: "both", summary: "즉발: 🔵 1개 획득 / 환기: 손패로 귀환", effect: { action: "undine" } },
            { id: 204, name: "갓파", type: "💧 PASSIVE", cost: 1, timing: "passive", summary: "지속: 🔵 마법석을 지불하여 카드 소환 시 2점 획득", effect: { action: "kappa" } },
            { id: 205, name: "네시", type: "💧 REFRESH", cost: 2, timing: "refresh", summary: "환기: 전장에 드래곤 속성이 없다면 승점 2점 획득", effect: { action: "nessie" } },
            { id: 206, name: "운디네 여왕", type: "💧 REFRESH", cost: 3, timing: "refresh", summary: "환기: 3코스트(🔵) 마법석 1개를 획득합니다.", effect: { action: "queen_undine" } },
            { id: 207, name: "우렁각시", type: "💧 REFRESH", cost: 3, timing: "refresh", summary: "환기: 🔵1개를 🟣1개로 변환 또는 🟣1개를 🔵3개로 변환", effect: { action: "snail_bride" } },
            { id: 208, name: "상급 설녀", type: "💧 INSTANT", cost: 3, timing: "instant", summary: "즉발: 보유한 모든 3코스트(🔵) 마법석의 가치만큼 점수 획득", effect: { action: "high_yuki_onna" } },
            { id: 209, name: "해태", type: "💧 PASSIVE", cost: 3, timing: "passive", summary: "지속: 당신의 3코스트(🔵)와 6코스트(🟣)의 가치가 서로 반전", effect: { action: "haetae" } },
            { id: 210, name: "물의 거인", type: "💧 INSTANT / PASSIVE", cost: 4, timing: "both", summary: "즉발: 🔵 2개 획득 / 지속: 보유한 🔵 및 🟣 가치 +1 상승", effect: { action: "water_giant" } },
            { id: 211, name: "레비아탄", type: "💧 INSTANT", cost: 4, timing: "instant", summary: "즉발: +7점 획득. 선택한 플레이어의 드래곤 1장 파괴", effect: { action: "leviathan" } },
            { id: 212, name: "트리톤", type: "💧 PASSIVE", cost: 4, timing: "passive", summary: "지속: 당신이 물 속성 카드를 드래프트(길들이기)하면 즉시 🔵 2개 획득", effect: { action: "triton" } },
            { id: 213, name: "히드라", type: "💧 INSTANT", cost: 4, timing: "instant", summary: "즉발: [🟣획득 / 1장 뽑기 / 🔵2개 획득 / 4점] 중 2가지 선택", effect: { action: "hydra" } },
            { id: 214, name: "카리브디스", type: "💧 REFRESH", cost: 5, timing: "refresh", summary: "환기: 보유한 🔵 1개를 버리면 승점 5점을 얻습니다.", effect: { action: "charybdis" } },
            { id: 215, name: "포세이돈", type: "💧 INSTANT", cost: 7, timing: "instant", summary: "즉발: 소환되어 있는 당신의 물 속성 카드 1장마다 3점 획득", effect: { action: "poseidon" } },

            // ================= ⛰️ 땅 속성 15장 (301 ~ 315) =================
            { id: 301, name: "새싹의 정령", type: "⛰️ INSTANT", cost: 0, timing: "instant", summary: "즉발: 손패 1장 버리고 다른 1장 무료 소환", effect: { action: "sprout_spirit" } },
            { id: 302, name: "고블린", type: "⛰️ REFRESH", cost: 1, timing: "refresh", summary: "환기: 원하는 상대로부터 승점 1점을 빼앗아옵니다.", effect: { action: "goblin" } },
            { id: 303, name: "숲의 정령", type: "⛰️ INSTANT", cost: 2, timing: "instant", summary: "즉발: 손패 1장 버리고 그 비용만큼 승점 획득", effect: { action: "forest_spirit" } },
            { id: 304, name: "가고일", type: "⛰️ PASSIVE", cost: 2, timing: "passive", summary: "지속: 🟣 마법석을 지불하여 소환 시 승점 3점 획득", effect: { action: "gargoyle" } },
            { id: 305, name: "트롤", type: "⛰️ REFRESH", cost: 3, timing: "refresh", summary: "환기: 🟣 마법석 보유 중이면 승점 3점 획득", effect: { action: "troll" } },
            { id: 306, name: "바실리스크", type: "⛰️ REFRESH", cost: 3, timing: "refresh", summary: "환기: 0/1/2점 잃고 🔴/🔵/🟣 마법석 중 하나 선택 획득", effect: { action: "basilisk" } },
            { id: 307, name: "고블린 병사", type: "⛰️ REFRESH", cost: 4, timing: "refresh", summary: "환기: 나보다 점수 높은 상대가 있으면 +4점, 없으면 -4점", effect: { action: "goblin_soldier" } },
            { id: 308, name: "메두사", type: "⛰️ REFRESH", cost: 4, timing: "refresh", summary: "환기: 손패 1장 버리면 🟣 마법석 1개 획득", effect: { action: "medusa" } },
            { id: 309, name: "케르베로스", type: "⛰️ INSTANT", cost: 5, timing: "instant", summary: "즉발: 전장의 내 다른 카드를 최대 3장까지 폐기(버림)", effect: { action: "cerberus" } },
            { id: 310, name: "바위 골렘", type: "⛰️ INSTANT", cost: 6, timing: "instant", summary: "즉발: 보유한 모든 🟣 마법석의 가치만큼 승점 획득", effect: { action: "rock_golem" } },
            { id: 311, name: "진흙 슬라임", type: "⛰️ INSTANT / REFRESH", cost: 6, timing: "both", summary: "즉발: 승점 +6점 / 환기: 손패로 귀환", effect: { action: "mud_slime" } },
            { id: 312, name: "미믹", type: "⛰️ REFRESH", cost: 6, timing: "refresh", summary: "환기: 버려진 땅 속성 카드 중 1장 골라 손패 회수", effect: { action: "mimic" } },
            { id: 313, name: "돌 골렘", type: "⛰️ INSTANT", cost: 6, timing: "instant", summary: "즉발: 내가 가진 모든 마법석을 🟣 마법석으로 전원 치환", effect: { action: "stone_golem" } },
            { id: 314, name: "베헤모스", type: "⛰️ INSTANT", cost: 9, timing: "instant", summary: "즉발: 소환되어 있는 내 카드 계열(속성) 종류마다 3점 획득", effect: { action: "behemoth" } },
            { id: 315, name: "모래거인", type: "⛰️ INSTANT", cost: 10, timing: "instant", summary: "즉발: 소환되어 있는 땅 속성 카드 1장마다 4점 획득", effect: { action: "sand_giant" } },

            // ================= 🍃 바람 속성 15장 (401 ~ 415) =================
            { id: 401, name: "민들레 요정", type: "🍃 INSTANT / REFRESH", cost: 3, timing: "both", summary: "즉발: 카드 1장 드로우 / 환기: 손패로 귀환", effect: { action: "dandelion_fairy" } },
            { id: 402, name: "페가수스", type: "🍃 INSTANT / PASSIVE", cost: 3, timing: "both", summary: "즉발: 카드 1장 드로우 / 지속: 모든 카드 소환 비용 1 감소", effect: { action: "pegasus" } },
            { id: 403, name: "텐구", type: "🍃 INSTANT", cost: 3, timing: "instant", summary: "즉발: 승점 +6점 획득 후 이 카드를 덱 맨 위에 배치", effect: { action: "tengu" } },
            { id: 404, name: "하피", type: "🍃 REFRESH", cost: 3, timing: "refresh", summary: "환기: 내 전장 카드 수와 손패 수가 같다면 승점 +3점", effect: { action: "harpy" } },
            { id: 405, name: "지니", type: "🍃 INSTANT", cost: 4, timing: "instant", summary: "즉발: 현재 내 전장에 깔린 모든 환기 효과를 즉시 동시 연쇄 발동", effect: { action: "djinn" } },
            { id: 406, name: "보레아스", type: "🍃 INSTANT", cost: 4, timing: "instant", summary: "즉발: 전장의 바람 속성 1장당 1점 획득 후 즉시 손패 귀환", effect: { action: "boreas" } },
            { id: 407, name: "실프", type: "🍃 INSTANT / PASSIVE", cost: 4, timing: "both", summary: "즉발: 카드 1장 드로우 / 지속: 카드 소환할 때마다 승점 +1점", effect: { action: "sylph" } },
            { id: 408, name: "히포그리프", type: "🍃 INSTANT / PASSIVE", cost: 4, timing: "both", summary: "즉발: 카드 1장 드로우 / 지속: 바람 속성 소환 비용 2 감소", effect: { action: "hypogriff" } },
            { id: 409, name: "발키리", type: "🍃 REFRESH", cost: 5, timing: "refresh", summary: "환기: 소환되어 있는 내 카드 계열(속성) 종류마다 1점 획득", effect: { action: "valkyrie" } },
            { id: 410, name: "상급 지니", type: "🍃 REFRESH", cost: 5, timing: "refresh", summary: "환기: 내 전장의 다른 카드의 환기 효과 1개를 복사해 발동", effect: { action: "high_djinn" } },
            { id: 411, name: "오딘", type: "🍃 REFRESH", cost: 6, timing: "refresh", summary: "환기: 손패 6장 이상이면 🟣 획득, 아니면 승점 +2점", effect: { action: "odin" } },
            { id: 412, name: "프레이야", type: "🍃 REFRESH", cost: 7, timing: "refresh", summary: "환기: 전장에 깔린 내 환기 타이밍 카드 1장마다 1점 획득", effect: { action: "freyja" } },
            { id: 413, name: "그리폰", type: "🍃 REFRESH", cost: 7, timing: "refresh", summary: "환기: 덱에서 카드 1장을 드로우하여 손패에 추가", effect: { action: "gryphon" } },
            { id: 414, name: "루드라", type: "🍃 INSTANT", cost: 8, timing: "instant", summary: "즉발: 현재 손패에 든 카드 1장마다 승점 +2점 획득", effect: { action: "rudra" } },
            { id: 415, name: "기린", type: "🍃 INSTANT", cost: 10, timing: "instant", summary: "즉발: 전장에 소환되어 있는 내 카드 1장마다 승점 +2점 획득", effect: { action: "qilin" } },

            // ================= 🐉 드래곤 속성 10장 (501 ~ 510) =================
            { id: 501, name: "드래곤 알", type: "🐉 INSTANT", cost: 3, timing: "instant", summary: "즉발: 자신을 파괴하고 패의 다른 드래곤 1장을 무료 소환", effect: { action: "dragon_egg" } },
            { id: 502, name: "타이들", type: "🐉 INSTANT", cost: 5, timing: "instant", summary: "즉발: 전장의 드래곤 속성 카드 1장마다 승점 +5점 대량 획득", effect: { action: "tidal" } },
            { id: 503, name: "마리나", type: "🐉 INSTANT", cost: 7, timing: "instant", summary: "즉발: +7점 획득. 지정 플레이어의 불 속성 카드 1장 파괴", effect: { action: "marina" } },
            { id: 504, name: "엠버", type: "🐉 INSTANT", cost: 7, timing: "instant", summary: "즉발: +7점 획득. 지정 플레이어의 물 속성 카드 1장 파괴", effect: { action: "amber" } },
            { id: 505, name: "거스트", type: "🐉 INSTANT", cost: 8, timing: "instant", summary: "즉발: +8점 획득. 지정 플레이어의 땅 속성 카드 1장 파괴", effect: { action: "gust" } },
            { id: 506, name: "볼더", type: "🐉 INSTANT", cost: 8, timing: "instant", summary: "즉발: +8점 획득. 지정 플레이어의 바람 속성 카드 1장 파괴", effect: { action: "boulder" } },
            { id: 507, name: "에어리스", type: "🐉 INSTANT", cost: 9, timing: "instant", summary: "즉발: 내 다른 카드 1장 손패 회수 + 그 카드 비용만큼 승점 획득", effect: { action: "aeris" } },
            { id: 508, name: "스코치", type: "🐉 INSTANT", cost: 9, timing: "instant", summary: "즉발: 내 전장에 놓인 다른 아군의 즉발 효과 1개를 그대로 복사", effect: { action: "scorch" } },
            { id: 509, name: "윌로우", type: "🐉 INSTANT", cost: 10, timing: "instant", summary: "즉발: 🔴,🔵,🟣 각 1개씩 충전 + 승점 3점 + 카드 1장 드로우", effect: { action: "willow" } },
            { id: 510, name: "이터니티", type: "🐉 INSTANT", cost: 12, timing: "instant", summary: "즉발: 전장의 내 카드 속성 계열 종류마다 승점 +4점 피니시", effect: { action: "eternity" } },

            // ================== 🔥 불 속성 확장 6장 (601~606) ==================
            { id: 601, name: "불쥐",       type: "🔥 INSTANT",         cost: 1, timing: "instant", summary: "즉발: 소환된 자신의 카드 중 비용 3 이하 1장마다 1점", effect: { action: "fire_rat" } },
            { id: 602, name: "잿불",       type: "🔥 PASSIVE",         cost: 1, timing: "passive", summary: "지속: 카드 제거 행동으로 내 카드 버릴 때, 버린 더미 대신 손패로 귀환 + 라운드 수만큼 점수 획득", effect: { action: "embers" } },
            { id: 603, name: "불개",       type: "🔥 REFRESH",         cost: 2, timing: "refresh", summary: "환기: 보유 마법석 4개 이상이면 2점 또는 1원 3개 획득", effect: { action: "fire_dog" } },
            { id: 604, name: "불보라",     type: "🔥 INSTANT / PASSIVE", cost: 2, timing: "both",  summary: "(즉발) 불 카드 2장마다 1점 / (지속) 마법석 4개 이상이면 즉시 귀환", effect: { action: "firestorm" } },
            { id: 605, name: "헤파이스토스", type: "🔥 REFRESH",       cost: 3, timing: "refresh", summary: "환기: [3원/1원×3/2점] 중 1가지 포기 → 나머지 2가지 획득", effect: { action: "hephaestus" } },
            { id: 606, name: "벨페고르",   type: "🔥 INSTANT / PASSIVE", cost: 4, timing: "both",  summary: "(즉발) 1원 획득 / (지속) 불 카드 소환 비용 1원으로 고정", effect: { action: "belphegor" } },

            // ================== 💧 물 속성 확장 6장 (607~612) ==================
            { id: 607, name: "타와레트",   type: "💧 INSTANT",         cost: 0, timing: "instant", summary: "즉발: 손에서 원하는 만큼 버리고, 1장당 3원 획득", effect: { action: "taweret" } },
            { id: 608, name: "멜루진",     type: "💧 INSTANT",         cost: 3, timing: "instant", summary: "즉발: 손에서 최대 3장 버리고, 1장당 4원 획득", effect: { action: "melusine" } },
            { id: 609, name: "탈라사",     type: "💧 INSTANT / PASSIVE", cost: 4, timing: "both",  summary: "(즉발) 물 계열 1장마다 1점 / (지속) 3원 획득 시 즉시 귀환", effect: { action: "thalassa" } },
            { id: 610, name: "세이렌",     type: "💧 REFRESH",         cost: 5, timing: "refresh", summary: "환기: 손에서 1장 버리면 3원 + 2점 획득", effect: { action: "siren" } },
            { id: 611, name: "크라켄",     type: "💧 INSTANT",         cost: 5, timing: "instant", summary: "즉발: 계열 선택, 그 계열 소환 카드 1장마다 2점 획득", effect: { action: "kraken" } },
            { id: 612, name: "아쿨트",     type: "💧 INSTANT",         cost: 6, timing: "instant", summary: "즉발: 공용 버린 더미의 드래곤 카드 1장을 무료 소환", effect: { action: "akult" } },

            // ================== ⛰️ 땅 속성 확장 6장 (613~618) ==================
            { id: 613, name: "두두리",     type: "⛰️ INSTANT / REFRESH", cost: 0, timing: "both", summary: "(즉발) 1점 잃고 마법석 1개 승급 / (환기) 귀환", effect: { action: "duduri" } },
            { id: 614, name: "두두리 대왕", type: "⛰️ PASSIVE",        cost: 3, timing: "passive", summary: "지속: 카드 판매 시 얻는 마법석 중 1개 승급", effect: { action: "duduri_king" } },
            { id: 615, name: "맨드레이크", type: "⛰️ INSTANT / REFRESH", cost: 6, timing: "both", summary: "(즉발) 3점 획득 / (환기) 버리거나 2점 잃기 선택 → 6원 획득", effect: { action: "mandrake" } },
            { id: 616, name: "아누비스",   type: "⛰️ INSTANT",         cost: 6, timing: "instant", summary: "즉발: 자기 다른 소환 카드 1장 버리고, 비용만큼 점수 획득", effect: { action: "anubis" } },
            { id: 617, name: "토템",       type: "⛰️ PASSIVE",         cost: 6, timing: "passive", summary: "지속: 자기 다른 소환 카드 버릴 때마다 6원 누적 획득", effect: { action: "totem" } },
            { id: 618, name: "웬디고",     type: "⛰️ INSTANT / PASSIVE", cost: 7, timing: "both",  summary: "(즉발) 땅 계열 1장마다 2점 / (지속) 점수 1점이라도 잃으면 즉시 귀환", effect: { action: "wendigo" } },

            // ================== 🍃 바람 속성 확장 6장 (619~624) ==================
            { id: 619, name: "날다람쥐",   type: "🍃 INSTANT / REFRESH", cost: 4, timing: "both", summary: "(즉발) 카드 1장 뽑기 / (환기) 카드 1장 뽑고, 손의 카드 1장을 더미 맨 위로", effect: { action: "flying_squirrel" } },
            { id: 620, name: "밴시",       type: "🍃 INSTANT / PASSIVE", cost: 4, timing: "both",  summary: "(즉발) 소환 카드 계열 종류마다 1점 / (지속) 카드 뽑으면 즉시 귀환", effect: { action: "banshee" } },
            { id: 621, name: "로크",       type: "🍃 REFRESH",          cost: 6, timing: "refresh", summary: "환기: 계열 선택, 그 계열 소환 카드 1장마다 1점 획득", effect: { action: "roc" } },
            { id: 622, name: "호루스",     type: "🍃 INSTANT",          cost: 7, timing: "instant", summary: "즉발: 카드 1장 무료 소환 + 비용만큼 점수 획득", effect: { action: "horus" } },
            { id: 623, name: "로키",       type: "🍃 PASSIVE / REFRESH", cost: 7, timing: "passive", summary: "(지속) 자기 차례마다 이 카드를 원하는 계열로 취급 / (환기) 지속 효과 카드 1장마다 1점", effect: { action: "loki" } },
            { id: 624, name: "안주",       type: "🍃 INSTANT",          cost: 9, timing: "instant", summary: "즉발: 손의 모든 카드 잠시 공개, 계열 종류마다 3점", effect: { action: "anzu" } },

            // ================== 🐉 드래곤 확장 4장 (625~628) ==================
            { id: 625, name: "딥다이브",   type: "🐉 INSTANT",          cost: 7, timing: "instant", summary: "즉발: 7점 획득, 대상 플레이어의 물 계열 카드 1장과 이 카드를 교환", effect: { action: "deepdive" } },
            { id: 626, name: "파이로",     type: "🐉 INSTANT",          cost: 7, timing: "instant", summary: "즉발: 7점 획득, 대상 플레이어의 불 계열 카드 1장과 이 카드를 교환", effect: { action: "pyro" } },
            { id: 627, name: "위스퍼",     type: "🐉 INSTANT",          cost: 8, timing: "instant", summary: "즉발: 8점 획득, 대상 플레이어의 바람 계열 카드 1장과 이 카드를 교환", effect: { action: "whisper" } },
            { id: 628, name: "락스케일",   type: "🐉 INSTANT",          cost: 8, timing: "instant", summary: "즉발: 8점 획득, 대상 플레이어의 땅 계열 카드 1장과 이 카드를 교환", effect: { action: "rockscale" } }
        ];
        await Card.insertMany(realCards);
        console.log(`✅ [98장 완성] 기본 70장 + 아티팩츠 확장 28장 데이터 베이스 구축 완료!`);
    } catch (err) {
        console.error("❌ 카드 DB 주입 실패:", err);
    }
}

// 🃏 전체 카드 불러오기 API
app.get('/api/cards', async (req, res) => {
    try {
        const cards = await Card.find({});
        res.json(cards);
    } catch (err) {
        res.status(500).json({ message: "서버 오류" });
    }
});

// 🔐 회원가입 API
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password, nickname } = req.body;
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.status(400).json({ success: false, message: "중복 아이디" });

        const newUser = new User({ username, password, nickname });
        await newUser.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 🔓 로그인 API
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) return res.status(400).json({ success: false });
        res.json({ success: true, nickname: user.nickname });
    } catch (err) { res.status(500).json({ success: false }); }
});

// =================================================================
// 🌐 [온라인 룸 코드 매칭] 실시간 방 생성 및 참가 제어 엔진
// =================================================================
io.on('connection', (socket) => {
    console.log(`🌐 [소켓 연결] 테이머 접속. ID: ${socket.id}`);

    // 👑 [방 개설]
    socket.on('createRoom', async (payload) => {
        // payload는 { nickname, expansions } 또는 하위 호환을 위해 문자열(닉네임)도 허용
        const nickname = (typeof payload === 'object' && payload !== null) ? payload.nickname : payload;
        const expansions = (typeof payload === 'object' && payload !== null && payload.expansions) ? payload.expansions : {};

        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        socket.join(roomCode);

        let allCardsPool = [];
        let sharedMarketCards = [];
        
        try {
            // 🚨 [버그 수정] .lean() 없이 Card.find()를 쓰면 진짜 Mongoose 문서가 반환되는데,
            // 이 경우 claimedBy처럼 스키마에 없는 임시 필드를 나중에 직접 박아 넣어도
            // 소켓으로 보낼 때(JSON 직렬화 시 .toJSON()이 스키마 필드만 남김) 그 필드가 통째로 사라집니다.
            // → 클라이언트는 "찜 표시가 떴다가 바로 사라지는" 현상을 겪게 됩니다.
            // .lean()으로 순수 JS 객체를 받아오면 어떤 필드든 자유롭게 추가/직렬화가 가능해집니다.
            allCardsPool = await Card.find({}).lean();

            for (let i = allCardsPool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [allCardsPool[i], allCardsPool[j]] = [allCardsPool[j], allCardsPool[i]];
            }
            
            for (let i = 0; i < 6; i++) {
                if (allCardsPool.length > 0) {
                    sharedMarketCards.push(allCardsPool.shift());
                }
            }
            console.log(`🎰 [고유 덱 빌드] 총 [${allCardsPool.length}장] 덱 구축 완료. (방 코드: ${roomCode})`);
        } catch (error) {
            console.error("🚨 DB 카드 로드 에러:", error);
            sharedMarketCards = Array.from({length: 6}, (_, i) => ({
                id: i, name: `임시 카드 ${i + 1}`, type: '🔥 INSTANT', cost: 3, summary: "인프라 체크 필요"
            }));
            allCardsPool = [...sharedMarketCards];
        }

        activeRooms[roomCode] = {
            roomID: roomCode,
            leaderID: socket.id,
            players: [{ id: socket.id, nickname: nickname || "방장 테이머" }],
            currentRound: 1,
            gameMainDeck: allCardsPool,
            discardPile: [],
            marketCards: sharedMarketCards,
            currentTurnOwnerIndex: 0,
            turnSequence: [],
            markersPlaced: 0,
            expansions: { artifacts: !!(expansions.artifacts) }
        };

        socket.emit('roomCreated', {
            roomCode: roomCode,
            players: activeRooms[roomCode].players,
            marketCards: sharedMarketCards,
            expansions: activeRooms[roomCode].expansions
        });

        console.log(`🏰 [방 생성] [${roomCode}] 모드: ${expansions.artifacts ? '⚗️ 아티팩츠 확장' : '📜 기본판'}`);
    });

    // 🤝 [방 입장]
    socket.on('joinRoom', (data) => {
        const { roomCode, nickname } = data;
        const targetRoom = roomCode ? roomCode.toUpperCase().trim() : "";

        if (!activeRooms[targetRoom]) {
            socket.emit('joinError', "🚨 존재하지 않는 방 코드입니다!");
            return;
        }

        if (activeRooms[targetRoom].players.length >= 4) {
            socket.emit('joinError', "🚨 정원 초과 방입니다! (최대 4명)");
            return;
        }

        socket.join(targetRoom);
        activeRooms[targetRoom].players.push({ id: socket.id, nickname: nickname || "참가자 테이머" });

        io.to(targetRoom).emit('roomUpdate', {
            roomID: targetRoom,
            players: activeRooms[targetRoom].players,
            leaderID: activeRooms[targetRoom].leaderID,
            expansions: activeRooms[targetRoom].expansions || {}
        });
    });

    // 🌟🌙☀️ [선플레이어 결정 - 마커 선택制] 마커 3종(별/달/해) 중 하나를 10초 안에 고르고,
    // 고른 마커에 랜덤 값을 부여해 정렬한 결과로 선플레이어 순서를 정한다.
    const TURN_ORDER_MARKERS = ['star', 'moon', 'sun', 'cloud'];

    function finalizeMarkerPhase(roomID) {
        const room = activeRooms[roomID];
        if (!room || !room.markerPhaseActive) return;
        room.markerPhaseActive = false;
        if (room.markerPhaseTimeout) {
            clearTimeout(room.markerPhaseTimeout);
            room.markerPhaseTimeout = null;
        }

        const picks = room.markerPicks || {};
        const takenMarkers = new Set(Object.values(picks));

        // 시간 내에 못 고른 플레이어는 남은 마커 중 하나를 무작위로 배정받는다.
        room.players.forEach(player => {
            if (!picks[player.id]) {
                const remaining = TURN_ORDER_MARKERS.filter(m => !takenMarkers.has(m));
                const pool = remaining.length > 0 ? remaining : TURN_ORDER_MARKERS;
                const assigned = pool[Math.floor(Math.random() * pool.length)];
                picks[player.id] = assigned;
                takenMarkers.add(assigned);
            }
        });

        const ranked = room.players.map(player => ({
            id: player.id,
            nickname: player.nickname,
            marker: picks[player.id],
            randomValue: Math.random()
        }));

        ranked.sort((a, b) => b.randomValue - a.randomValue);

        const finalTurnOrder = ranked.map((res, index) => ({
            id: res.id,
            nickname: res.nickname,
            marker: res.marker,
            startScore: index,
            turnIndex: index
        }));

        room.turnSequence = finalTurnOrder;
        room.currentTurnOwnerIndex = 0;
        room.markerPicks = {};
        room.currentDraftStep = 0;
        room.snakeDraftSequence = generateSnakeDraftSequence(room.players.length);
        room.lastRoundArtifactByPlayer = {};

        // 아티팩츠 확장 활성 시 유물 공급 설정; 비활성 시 확장 카드(ID≥600) 제거
        if (room.expansions && room.expansions.artifacts) {
            room.artifactSupply = setupArtifactSupply(room.players.length);
        } else {
            room.gameMainDeck = room.gameMainDeck.filter(c => c.id < 600);
        }

        // Deal correct number of market cards for this player count
        const initMarketSize = room.players.length * 2;
        room.gameMainDeck = [...room.marketCards.filter(c => !room.expansions?.artifacts ? c.id < 600 : true), ...room.gameMainDeck];
        room.marketCards = [];
        for (let i = 0; i < initMarketSize; i++) {
            if (room.gameMainDeck.length > 0) room.marketCards.push(room.gameMainDeck.shift());
        }

        io.to(roomID).emit('gameStartSignal', {
            finalPlayers: room.players,
            sharedMarketCards: room.marketCards,
            turnSequence: finalTurnOrder,
            expansions: room.expansions || {},
            artifactSupply: room.artifactSupply || []
        });

        // 확장판이면 유물 드래프트 먼저, 기본판이면 카드 드래프트 바로 시작
        if (room.expansions && room.expansions.artifacts && room.artifactSupply && room.artifactSupply.length > 0) {
            startArtifactDraftPhase(roomID);
        } else {
            const firstDraftPlayer = finalTurnOrder[0];
            io.to(roomID).emit('draftTurnStart', {
                currentTurnOwnerID: firstDraftPlayer.id,
                currentTurnOwnerNickname: firstDraftPlayer.nickname,
                logMessage: `🎲 [드래프트 1/${room.snakeDraftSequence.length}] 첫 번째 드래프터: [ ${firstDraftPlayer.nickname} ] (60초)`
            });
            startPhaseTimer(roomID, 'DRAFT');
        }
    }

    // ⚙️ [아티팩츠 확장 토글] 방장만 변경 가능
    socket.on('setExpansion', (data) => {
        const { roomID, artifacts } = data;
        const room = activeRooms[roomID];
        if (!room || room.leaderID !== socket.id) return;
        if (!room.expansions) room.expansions = {};
        room.expansions.artifacts = !!artifacts;
        io.to(roomID).emit('expansionUpdated', { artifacts: room.expansions.artifacts });
    });

    // ⚗️ [유물 드래프트 찜] 드래프트 시작 시 유물 타일에 마커 드래그로 찜
    socket.on('action_claimArtifact', (data) => {
        const { roomID, artifactId } = data;
        const room = activeRooms[roomID];
        if (!room || room.currentServerPhase !== 'ARTIFACT_DRAFT') return;

        const selector = room.turnSequence[room.currentArtifactSelectorIdx];
        if (!selector || selector.id !== socket.id) return;

        const artifact = room.artifactSupply.find(a => a.id === artifactId);
        if (!artifact || artifact.claimedBy) return;

        // 직전 라운드 선택 제한 체크
        const lastId = (room.lastRoundArtifactByPlayer || {})[selector.nickname];
        if (lastId && lastId === artifactId && room.currentRound > 1) {
            socket.emit('artifactClaimError', { message: '직전 라운드에 선택한 유물은 연속으로 선택할 수 없습니다.' });
            return;
        }

        artifact.claimedBy = selector.nickname;
        if (!room.lastRoundArtifactByPlayer) room.lastRoundArtifactByPlayer = {};
        room.lastRoundArtifactByPlayer[selector.nickname] = artifactId;

        io.to(roomID).emit('artifactDraftUpdate', {
            artifactSupply: room.artifactSupply,
            pickerNickname: selector.nickname,
            artifactId,
            autoAssigned: false
        });

        room.currentArtifactSelectorIdx++;
        if (room.currentArtifactSelectorIdx >= room.turnSequence.length) {
            // 즉발 유물 효과는 카드 드래프트 완료 후 액션 단계 초입에 발동
            startCardDraftPhase(roomID);
        } else {
            const next = room.turnSequence[room.currentArtifactSelectorIdx];
            io.to(roomID).emit('artifactDraftNext', {
                currentSelectorID: next.id,
                currentSelectorNickname: next.nickname,
                lastRoundRestrictions: room.lastRoundArtifactByPlayer || {}
            });
            startPhaseTimer(roomID, 'ARTIFACT_DRAFT');
        }
    });

    // ⚔️ [유물 행동 사용] 행동 단계 중 1회 유물 행동 능력 사용
    socket.on('action_useArtifact', (data) => {
        const { roomID, artifactId, ownerNickname } = data;
        const room = activeRooms[roomID];
        if (!room || room.currentServerPhase !== 'ACTION') return;

        const artifact = room.artifactSupply && room.artifactSupply.find(a => a.id === artifactId && a.claimedBy === ownerNickname);
        if (!artifact) return;

        // 사용 완료 후 공급처 반환 (claimedBy null로 초기화)
        artifact.claimedBy = null;
        io.to(roomID).emit('artifactUsed', { artifactId, ownerNickname, artifact });
        console.log(`⚔️ [유물 사용] [${roomID}] ${ownerNickname} → [${artifact.nameKo}] 사용 후 반환`);
    });

    // 🌊 [아쿨트] 공용 버린 더미의 드래곤 카드 목록을 요청자에게 전송
    socket.on('action_akultFreeSummon', (data) => {
        const { roomID } = data;
        const room = activeRooms[roomID];
        if (!room) return;
        const dragonCards = (room.discardPile || []).filter(c => c.type && c.type.includes('🐉'));
        socket.emit('akultDragonList', { cards: dragonCards });
    });

    // 🚀 [게임 대전 개시] - 다이스 대신 마커 선택 단계를 먼저 연다.
    socket.on('requestStartGame', (data) => {
        const { roomID } = data;
        const room = activeRooms[roomID];
        if (!room || room.markerPhaseActive) return;
        if (room.players.length < 2) {
            socket.emit('joinError', "🚨 게임을 시작하려면 최소 2명이 필요합니다!");
            return;
        }

        room.markerPhaseActive = true;
        room.markerPicks = {};

        const durationMs = 10000;
        room.markerPhaseTimeout = setTimeout(() => finalizeMarkerPhase(roomID), durationMs);

        io.to(roomID).emit('markerSelectPhaseStart', {
            markers: TURN_ORDER_MARKERS,
            durationMs
        });
    });

    // 🌟 [마커 선택] 플레이어가 별/달/해 중 하나를 클릭해서 골랐을 때
    socket.on('requestMarkerPick', (data) => {
        const { roomID, marker } = data;
        const room = activeRooms[roomID];
        if (!room || !room.markerPhaseActive) return;
        if (!TURN_ORDER_MARKERS.includes(marker)) return;

        room.markerPicks = room.markerPicks || {};

        // 이미 고른 사람은 변경 불가, 이미 다른 사람이 가져간 마커는 선택 불가
        if (room.markerPicks[socket.id]) return;
        const alreadyTaken = Object.values(room.markerPicks).includes(marker);
        if (alreadyTaken) return;

        room.markerPicks[socket.id] = marker;

        const player = room.players.find(p => p.id === socket.id);
        io.to(roomID).emit('markerPickUpdate', {
            id: socket.id,
            nickname: player ? player.nickname : '???',
            marker
        });

        // 전원이 다 골랐으면 10초를 기다리지 않고 즉시 마감
        if (Object.keys(room.markerPicks).length >= room.players.length) {
            finalizeMarkerPhase(roomID);
        }
    });

    // ✅ [드래프트 완료] 플레이어가 자신의 드래프트 차례를 수동으로 종료할 때
    socket.on('action_endDraftTurn', (data) => {
        const { roomID } = data;
        const room = activeRooms[roomID];
        if (!room || room.currentServerPhase !== 'DRAFT') return;

        const currentDraftPlayer = room.turnSequence[room.currentTurnOwnerIndex];
        if (!currentDraftPlayer || currentDraftPlayer.id !== socket.id) return;

        forceEndCurrentPlayerDraftTurn(roomID);
    });

    // 🛒 [인게임 액션 1] 마켓 선점 동기화 (드래프트 단계: 현재 차례 플레이어만 선점 가능)
    socket.on('action_buyCard', (data) => {
        const { roomID, cardId, playerNickname } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        if (room.currentServerPhase === 'DRAFT') {
            const currentDraftPlayer = room.turnSequence[room.currentTurnOwnerIndex];
            if (!currentDraftPlayer || currentDraftPlayer.id !== socket.id) return;
        }

        const targetCard = room.marketCards.find(card => card.id === cardId);
        if (targetCard && !targetCard.claimedBy) {
            targetCard.claimedBy = playerNickname;

            if (typeof room.markersPlaced === 'undefined') room.markersPlaced = 0;
            room.markersPlaced++;

            console.log(`🎯 [선점] 방 [${roomID}] : ${playerNickname} -> [${targetCard.name}]`);

            io.to(roomID).emit('sync_marketUpdate', {
                marketCards: room.marketCards,
                pickerNickname: playerNickname,
                cardName: targetCard.name,
                serverMarkersPlaced: room.markersPlaced
            });

            if (room.currentServerPhase === 'DRAFT') {
                forceEndCurrentPlayerDraftTurn(roomID);
            }
        }
    });

    // 🔄 [인게임 액션 2] 바람 효과 마켓 리프레시
    socket.on('action_marketRefresh', (data) => {
        const { roomID, playerNickname } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        let freshCards = [];
        if (room.gameMainDeck.length < 6) {
            if (room.discardPile && room.discardPile.length > 0) {
                room.gameMainDeck = [...room.gameMainDeck, ...room.discardPile];
                room.discardPile = [];

                shuffleDeckPreservingTengu(room.gameMainDeck);
            }
        }

        for (let i = 0; i < 6; i++) {
            if (room.gameMainDeck.length > 0) freshCards.push(room.gameMainDeck.shift());
        }

        room.marketCards = freshCards;
        room.markersPlaced = 0; // 마커 카운트 리셋
        
        io.to(roomID).emit('sync_marketUpdate', {
            marketCards: room.marketCards,
            pickerNickname: "시스템",
            cardName: "새로고침",
            serverMarkersPlaced: 0,
            logMessage: `🔄 [마켓 환기] ${playerNickname}님에 의해 마켓 카드 6장이 전원 교체되었습니다!`
        });
    });

    // ⏱️ [인게임 액션 3] 턴 종료 선언 집계 엔진
    socket.on('action_endTurn', (data) => {
        const { roomID, actionType, cardName, cardCost, cardType, userNickname, currentScore, currentStones, currentSummonZone } = data;
        const room = activeRooms[roomID];
        if (!room || room.turnSequence.length === 0) return;

        if (!room.actionFinishedCount) room.actionFinishedCount = 0;

        const currentTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];
        room.actionFinishedCount++; 

        if (actionType && (actionType === 'sell' || actionType === 'remove')) {
            room.discardPile.push({ name: cardName, cost: cardCost, type: cardType });
        }

        const pName = userNickname || currentTurnPlayer.nickname;
        if (!room.rivalsMemory) room.rivalsMemory = {};
        room.rivalsMemory[pName] = {
            score: currentScore || 0,
            stones: currentStones || { red: 0, blue: 0, purple: 0 },
            summonZone: currentSummonZone || []
        };

        if (room.actionFinishedCount >= room.turnSequence.length) {
            finishActionPhase(roomID);
        } else {
            room.currentTurnOwnerIndex = (room.currentTurnOwnerIndex + 1) % room.turnSequence.length;
            const nextTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];

            io.to(roomID).emit('sync_turnUpdate', {
                currentTurnOwnerID: nextTurnPlayer.id,
                currentTurnOwnerNickname: nextTurnPlayer.nickname,
                actionType: actionType || null,
                cardName: cardName || null,
                cardCost: cardCost || null,
                cardType: cardType || null,
                userNickname: pName,
                currentScore: currentScore || 0,
                currentStones: currentStones || { red: 0, blue: 0, purple: 0 },
                currentSummonZone: currentSummonZone || [],
                marketCards: room.marketCards, // 턴 전환 패킷에도 마켓 동기화 락 추가!
                logMessage: `⏱️ [턴 전환] ${pName}님이 턴을 넘겼습니다. 다음 차례: [ ${nextTurnPlayer.nickname} ]`
            });
            startPhaseTimer(roomID, 'ACTION');
        }
    });

    // 📡 환기 정산 마감 집계 엔진
    socket.on('playerFinishedRefresh', async (data) => {
        const { roomID, userNickname, finalScore, summonZoneCount } = data;
        const room = activeRooms[roomID];
        if (!room || room.turnSequence.length === 0) return;

        if (!room.refreshFinishedPlayers) room.refreshFinishedPlayers = [];

        if (!room.refreshFinishedPlayers.includes(socket.id)) {
            room.refreshFinishedPlayers.push(socket.id);
        }

        if (!room.finalScoresThisRound) room.finalScoresThisRound = {};
        room.finalScoresThisRound[socket.id] = {
            nickname: userNickname,
            score: finalScore || 0,
            summonZoneCount: summonZoneCount || 0
        };

        if (room.refreshFinishedPlayers.length >= room.players.length) {
            finishRefreshPhaseAndContinue(roomID);
        } else {
            room.currentTurnOwnerIndex = (room.currentTurnOwnerIndex + 1) % room.turnSequence.length;
            const nextTurnPlayer = room.turnSequence[room.currentTurnOwnerIndex];

            io.to(roomID).emit('sync_turnUpdate', {
                currentTurnOwnerID: nextTurnPlayer.id,
                currentTurnOwnerNickname: nextTurnPlayer.nickname,
                marketCards: room.marketCards,
                logMessage: `⏱️ [환기 턴 전환] 다음 정산 차례는 [ ${nextTurnPlayer.nickname} ] 님입니다.`
            });
            startPhaseTimer(roomID, 'REFRESH');
        }
    });

    // 📡 실시간 액션 동기화 및 자원 바인딩 릴레이
    socket.on('playerExecutedAction', (data) => {
        const { roomID, actionType, cardId, cardName, cardCost, cardType, userNickname, currentScore, currentStones, currentSummonZone, forcedBy, sourceCardName, fromHand, reason, casterNickname } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        let actionMsg = "";
        if (actionType === 'summon') actionMsg = `⚔️ [소환 알림] ${userNickname}님이 [${cardName}]을 전장에 소환했습니다!`;
        if (actionType === 'remove') {
            if (forcedBy) {
                actionMsg = `🐉 [강제 파괴] ${forcedBy}님이 [${sourceCardName}]의 효과로 ${userNickname}님의 [${cardName}]을 파괴했습니다!`;
            } else if (fromHand) {
                actionMsg = `🍂 [손패 폐기] ${userNickname}님이 손패에서 [${cardName}]을 버렸습니다.`;
            } else {
                actionMsg = `💀 [제거 알림] ${userNickname}님이 전장의 [${cardName}]을 폐기했습니다.`;
            }
        }
        if (actionType === 'sell') actionMsg = `🪙 [판매 알림] ${userNickname}님이 [${cardName}]을 정산소에 판매했습니다.`;
        if (actionType === 'tame') actionMsg = `🧝‍♀️ [길들이기 알림] ${userNickname}님이 카드 1장을 손패로 킵했습니다.`;
        if (actionType === 'scoreAdjust') {
            actionMsg = reason === 'goblin_steal'
                ? `👺 [고블린 강탈] ${casterNickname}님이 ${userNickname}님으로부터 승점 1점을 빼앗았습니다!`
                : reason === 'goblin_gain'
                ? `👺 [고블린 강탈] ${userNickname}님이 승점 1점을 획득했습니다!`
                : `📊 [점수 갱신] ${userNickname}님의 승점이 갱신되었습니다.`;
        }

        if (actionType === 'sell' || actionType === 'remove') {
            if (!room.discardPile) room.discardPile = [];
            room.discardPile.push({ name: cardName, cost: cardCost || 2, type: cardType || '⛰️ PASSIVE' });
        }

        // 🚨 [버그 수정] sell/tame은 마켓에서 카드를 실제로 빼가는 행동인데,
        // 여기서 room.marketCards를 갱신하지 않으면 바로 아래에서 그대로 다시 방송되어,
        // 클라이언트가 그 stale한 배열로 자기 로컬 marketCards를 덮어써 버려서
        // "판 카드가 다시 마켓에 부활"하는 현상이 발생합니다.
        if ((actionType === 'sell' || actionType === 'tame') && cardId !== undefined && cardId !== null && room.marketCards) {
            const idx = room.marketCards.findIndex(c => c.id === cardId);
            if (idx !== -1) room.marketCards.splice(idx, 1);
        }

        if (!room.rivalsMemory) room.rivalsMemory = {};
        room.rivalsMemory[userNickname] = {
            score: currentScore || 0,
            stones: currentStones || { red: 0, blue: 0, purple: 0 },
            summonZone: currentSummonZone || []
        };

        io.to(roomID).emit('sync_rivalActionUpdate', {
            targetNickname: userNickname,
            actionType: actionType, 
            cardName: cardName,
            cardCost: cardCost || 2,
            cardType: cardType || '⛰️ PASSIVE',
            updatedScore: currentScore || 0, 
            updatedStones: currentStones || { red: 0, blue: 0, purple: 0 },
            updatedSummonZone: currentSummonZone || [],
            logMsg: actionMsg
        });

        io.to(roomID).emit('sync_turnUpdate', {
            currentTurnOwnerID: socket.id,
            currentTurnOwnerNickname: userNickname,
            actionType: actionType,
            cardName: cardName,
            cardCost: cardCost || 2,
            cardType: cardType || '⛰️ PASSIVE',
            userNickname: userNickname,
            currentScore: currentScore || 0,
            currentStones: currentStones || { red: 0, blue: 0, purple: 0 },
            currentSummonZone: currentSummonZone || [],
            marketCards: room.marketCards, // 🌟 실시간 액션 릴레이 시 마켓 정보 동봉 처리!
            logMessage: actionMsg
        });
    });

    // 🐉 [원소 드래곤 5총사] 마리나/엠버/거스트/볼더/레비아탄의 대상 지정 알림을 그대로 릴레이.
    // 어떤 카드를 버릴지는 대상 플레이어 본인이 직접 고르므로, 서버는 "누가 누구를 지목했는지"만
    // 전달하고 실제 카드 제거는 대상 플레이어 클라이언트가 처리한 뒤 playerExecutedAction(remove)으로
    // 다시 방송한다.
    socket.on('requestForcedDiscardPrompt', (data) => {
        const { roomID, targetNickname, casterNickname, attr, label, sourceCardName } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        io.to(roomID).emit('forcedDiscardPrompt', {
            targetNickname,
            casterNickname,
            attr,
            label,
            sourceCardName
        });
    });

    // 👺 [고블린 전용] 승점 1점을 빼앗을 대상 지정 알림을 그대로 릴레이.
    // 실제 점수 차감은 대상 플레이어 본인의 클라이언트가 처리한 뒤 playerExecutedAction(scoreAdjust)
    // 으로 다시 방송한다.
    socket.on('requestGoblinSteal', (data) => {
        const { roomID, targetNickname, casterNickname } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        io.to(roomID).emit('goblinStealOrder', {
            targetNickname,
            casterNickname
        });
    });

    // 👺 [텐구 전용] 즉발 효과를 쓰고 나면 카드 자신을 덱 맨 위로 되돌린다. gameMainDeck은
    // 서버에만 있으므로, 클라이언트가 보낸 카드 전체 데이터를 그대로 배열 맨 앞(unshift)에 꽂는다.
    // 그래야 다음 드로우 효과(히드라 등)가 텐구를 다시 뽑을 수 있고, 아무도 안 뽑으면 다음 라운드
    // 마켓 6장을 채울 때(앞에서부터 6장 shift) 텐구가 그대로 포함된다.
    socket.on('requestReturnCardToDeckTop', (data) => {
        const { roomID, cardData } = data;
        const room = activeRooms[roomID];
        if (!room || !cardData) return;

        room.gameMainDeck.unshift(cardData);
    });

    // 🃏 [카드 드로우 전용] 히드라/그리폰/히포그리프/실프/페가수스/윌로우(+민들레 요정)의
    // "마켓/손패/전장/무덤에 없는 진짜 미사용 카드 뽑기" 요청 처리. gameMainDeck은 서버에만
    // 있으므로 여기서 직접 한 장을 꺼내, 요청한 소켓에게만 개인적으로 돌려준다(다른 플레이어에게는
    // 비공개).
    socket.on('requestDrawCard', (data) => {
        const { roomID, sourceCardName, destinationType } = data;
        const room = activeRooms[roomID];
        if (!room) return;

        if (room.gameMainDeck.length < 1 && room.discardPile && room.discardPile.length > 0) {
            room.gameMainDeck = [...room.gameMainDeck, ...room.discardPile];
            room.discardPile = [];

            shuffleDeckPreservingTengu(room.gameMainDeck);
        }

        if (room.gameMainDeck.length < 1) {
            socket.emit('drawCardResult', { success: false, sourceCardName, destinationType });
            return;
        }

        const drawnCard = room.gameMainDeck.shift();
        socket.emit('drawCardResult', { success: true, card: drawnCard, sourceCardName, destinationType });
    });

    // 🚪 [대기실 이전 버튼] 소켓은 유지하면서 방만 나가기
    socket.on('leaveRoom', (roomCode) => {
        if (!roomCode || !activeRooms[roomCode]) return;
        const room = activeRooms[roomCode];
        const originalLength = room.players.length;
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave(roomCode);

        if (room.players.length === 0) {
            delete activeRooms[roomCode];
            console.log(`💥 [방 폭파] [${roomCode}] 방장이 나가 방 삭제.`);
        } else if (room.players.length !== originalLength) {
            if (room.leaderID === socket.id) {
                room.leaderID = room.players[0].id;
            }
            io.to(roomCode).emit('roomUpdate', {
                roomID: roomCode,
                players: room.players,
                leaderID: room.leaderID,
                expansions: room.expansions || {}
            });
        }
        console.log(`🚪 [방 퇴장] ${socket.id} → [${roomCode}]`);
    });

    // 🔄 [게임 중 재연결] 새로고침 등으로 끊긴 플레이어를 기존 게임에 다시 연결
    socket.on('reconnectToGame', ({ roomCode, nickname }) => {
        const code = roomCode ? roomCode.toUpperCase().trim() : '';
        const room = activeRooms[code];
        if (!room) {
            socket.emit('reconnectFailed', { reason: '방을 찾을 수 없습니다.' });
            return;
        }
        const player = room.players.find(p => p.nickname === nickname);
        if (!player) {
            socket.emit('reconnectFailed', { reason: '플레이어 정보를 찾을 수 없습니다.' });
            return;
        }
        // 대기 중인 제거 타이머 취소
        if (player._dcTimer) { clearTimeout(player._dcTimer); player._dcTimer = null; }
        const oldId = player.id;
        player.id = socket.id;
        player._disconnected = false;
        if (room.leaderID === oldId) room.leaderID = socket.id;
        socket.join(code);
        const timerRemainingMs = (room.phaseTimerStartedAt && room.phaseTimerDurationMs)
            ? Math.max(0, room.phaseTimerDurationMs - (Date.now() - room.phaseTimerStartedAt))
            : 0;
        socket.emit('reconnectSuccess', {
            roomCode: code,
            players: room.players,
            marketCards: room.marketCards,
            currentRound: room.currentRound,
            turnSequence: room.turnSequence,
            currentPhase: room.currentServerPhase || 'DRAFT',
            timerRemainingMs,
        });
        console.log(`🔄 [재연결] ${nickname} → [${code}]`);
    });

    // 🔌 접속 종료 처리
    socket.on('disconnect', () => {
        Object.keys(activeRooms).forEach(roomCode => {
            const room = activeRooms[roomCode];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            const gameInProgress = room.turnSequence && room.turnSequence.length > 0;

            if (gameInProgress) {
                // 게임 중 끊김 → 60초 유예 후 제거
                player._disconnected = true;
                player._dcTimer = setTimeout(() => {
                    if (!activeRooms[roomCode]) return;
                    room.players = room.players.filter(p => p.nickname !== player.nickname);
                    if (room.players.length === 0) {
                        delete activeRooms[roomCode];
                        console.log(`💥 [방 폭파] [${roomCode}] 유예 만료 후 삭제.`);
                    } else {
                        if (room.leaderID === player.id) room.leaderID = room.players[0].id;
                    }
                    console.log(`⏱️ [유예 만료] ${player.nickname} 제거 [${roomCode}]`);
                }, 60000);
                console.log(`⏸️ [게임 중 끊김] ${player.nickname} 60초 유예 [${roomCode}]`);

                // 전원 접속 종료 시 → 유예 타이머 취소 후 즉시 방 폭파
                const allGone = room.players.every(p => p._disconnected);
                if (allGone) {
                    room.players.forEach(p => { if (p._dcTimer) { clearTimeout(p._dcTimer); p._dcTimer = null; } });
                    delete activeRooms[roomCode];
                    console.log(`💥 [방 폭파] [${roomCode}] 전원 접속 종료 → 즉시 삭제.`);
                }
            } else {
                // 대기실 끊김 → 즉시 제거 (기존 동작)
                const originalLength = room.players.length;
                room.players = room.players.filter(p => p.id !== socket.id);
                if (room.players.length !== originalLength) {
                    if (room.players.length === 0) {
                        delete activeRooms[roomCode];
                        console.log(`💥 [방 폭파] [${roomCode}] 방 삭제.`);
                    } else {
                        if (room.leaderID === socket.id) room.leaderID = room.players[0].id;
                        io.to(roomCode).emit('roomUpdate', {
                            roomID: roomCode, players: room.players, leaderID: room.leaderID, expansions: room.expansions || {}
                        });
                    }
                }
            }
        });
        console.log(`🔌 [소켓 종료] ID: ${socket.id}`);
    });
});

// =================================================================
// 🚀 [하이브리드 서버 가동]
// =================================================================
http.listen(PORT, () => {
    console.log(`🚀 [서버 가동] 전장 서버 활성화: http://localhost:${PORT}`);
});