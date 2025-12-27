const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

let rooms = {};

io.on('connection', (socket) => {
    console.log('Usuário conectado:', socket.id);

    // Envia a lista atual de salas para quem acabou de conectar
    socket.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));

    socket.on('createRoom', ({ roomName, password, userName }) => {
        if (rooms[roomName]) {
            socket.emit('error', 'Sala já existe');
            return;
        }
        rooms[roomName] = {
            name: roomName,
            password: password,
            host: socket.id,
            players: [{ id: socket.id, name: userName, coins: 2, cards: [], status: 'waiting' }],
            deck: [],
            gameStarted: false,
            turnIndex: 0
        };
        socket.join(roomName);
        io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));
        socket.emit('roomJoined', rooms[roomName]);
    });

    socket.on('joinRoom', ({ roomName, password, userName }) => {
        const room = rooms[roomName];
        if (!room) return socket.emit('error', 'Sala não encontrada');
        if (room.password && room.password !== password) return socket.emit('error', 'Senha incorreta');

        // Evita duplicidade do mesmo socket.id
        const already = room.players.some(p => p.id === socket.id);
        if (!already) {
            room.players.push({ id: socket.id, name: userName, coins: 2, cards: [], status: 'waiting' });
            socket.join(roomName);
        } else {
            const me = room.players.find(p => p.id === socket.id);
            if (me && userName && me.name !== userName) me.name = userName;
        }

        io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));
        io.to(roomName).emit('roomJoined', room);
    });

    // Atualiza a lista de salas para todos após alguém entrar
    io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));

    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        if (room.players.length < 2) return;

        room.starting = true;
        room.startingCountdown = 3;
        if (room.startingTimer) {
            clearInterval(room.startingTimer);
            room.startingTimer = null;
        }
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
        notify(roomName, 'Iniciando o jogo...');
        room.startingTimer = setInterval(() => {
            if (!room.starting) {
                clearInterval(room.startingTimer);
                room.startingTimer = null;
                return;
            }
            room.startingCountdown = (room.startingCountdown || 3) - 1;
            if (room.startingCountdown > 0) {
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            } else {
                clearInterval(room.startingTimer);
                room.startingTimer = null;
                // Preparar deck e distribuir
                const pCount = room.players.length;
                let cardsPerChar = pCount <= 4 ? 3 : (pCount <= 7 ? 4 : 5);
                const chars = ['ASSASSINO', 'DUQUE', 'CAPITAO', 'CONDESSA', 'EMBAIXADOR'];
                room.deck = [];
                chars.forEach(c => {
                    for(let i=0; i<cardsPerChar; i++) room.deck.push(c);
                });
                room.deck.sort(() => Math.random() - 0.5);
                room.players.forEach(p => {
                    p.cards = [room.deck.pop(), room.deck.pop()];
                    p.status = 'playing';
                });
                room.gameStarted = true;
                room.turnIndex = Math.floor(Math.random() * room.players.length);
                delete room.starting;
                delete room.startingCountdown;
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                const starter = room.players[room.turnIndex]?.name || '';
                notify(roomName, `Quem vai começar: ${starter}`);
            }
        }, 1000);
    });

    // NOVO: realizar ação do jogador da vez e avançar o turno
    socket.on('performAction', ({ roomName, action, targetId }) => {
        const room = rooms[roomName];
        if (!room) return socket.emit('error', 'Sala não encontrada');

        const current = room.players[room.turnIndex];
        if (!current || current.id !== socket.id) {
            return socket.emit('error', 'Não é seu turno');
        }

        // Se tem 10+ moedas, somente Coup é permitido
        if (current.coins >= 10 && action !== 'coup') {
            return socket.emit('error', 'Com 10+ moedas, você deve realizar Coup');
        }

        const advanceTurn = (room) => {
            if (room.players.length === 0) return;
            // ajusta índice se saiu alguém
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            // pula quem não está jogando
            let guard = 0;
            while (room.players[room.turnIndex]?.status !== 'playing' && guard < 50) {
                room.turnIndex = (room.turnIndex + 1) % room.players.length;
                guard++;
            }
        };

        const removeOneCardFrom = (playerIndex) => {
            const target = room.players[playerIndex];
            if (!target) return;
            target.cards.pop(); // remove uma carta (simplificado)
            if (target.cards.length === 0) {
                target.status = 'out';
                room.players.splice(playerIndex, 1);
                if (room.turnIndex > playerIndex) {
                    room.turnIndex--; // corrige índice do turno
                }
                if (room.turnIndex >= room.players.length) {
                    room.turnIndex = 0;
                }
            }
        };

        switch (action) {
            case 'income': {
                current.coins += 1;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                notify(roomName, `O jogador ${current.name} recebeu 1 moeda`);
                break;
            }
            case 'foreign_aid': {
                // Ajuda Externa deve ser declarada para permitir bloqueio/contestação
                return socket.emit('error', 'Ajuda Externa deve ser declarada (pode ser bloqueada por DUQUE)');
            }
            case 'tax': {
                current.coins += 3;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                break;
            }
            case 'coup': {
                if (current.coins < 7) return socket.emit('error', 'Coup custa 7 moedas');
                const targetIndex = room.players.findIndex(p => p.id === targetId);
                if (targetIndex === -1 || room.players[targetIndex]?.id === current.id) {
                    return socket.emit('error', 'Alvo inválido para Coup');
                }
                current.coins -= 7;
                const target = room.players[targetIndex];
                const attackerName = current.name;
                const targetName = target.name;
                if ((target.cards?.length || 0) <= 1) {
                    notify(roomName, `O JOGADOR ${attackerName} ACABA DE DAR UM GOLPE DE ESTADO NO JOGADOR ${targetName} E ELE FOI ELIMINADO DO JOGO.`);
                    removeOneCardFromIndex(room, targetIndex);
                    advanceTurn(room);
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = { type: 'loss_choice', source: 'coup', actorId: target.id, initiatorId: current.id, targetId: null, block: null, challenged: null };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    notify(roomName, `O JOGADOR ${attackerName} ACABA DE DAR UM GOLPE DE ESTADO NO JOGADOR ${targetName} E ELE ACABA DE PERDER UM PERSONAGEM.`);
                }
                break;
            }
            default:
                socket.emit('error', 'Ação inválida');
        }
    });

    // Remove jogador e limpa salas vazias ao desconectar
    socket.on('disconnect', () => {
        for (const [name, room] of Object.entries(rooms)) {
            const before = room.players.length;
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[name];
            } else if (room.host === socket.id) {
                room.host = room.players[0].id; // passa host para o primeiro
            }
            if (room.players.length !== before) {
                io.to(name).emit('gameStateUpdate', sanitizeRoom(room));
            }
        }
        io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));
    });

    // Helpers reutilizáveis — mantenha dentro do bloco de conexão
    const sanitizeRoom = (room) => {
        const { pendingTimer, startingTimer, ...safe } = room || {};
        return safe;
    };
    const notify = (roomName, text) => {
        io.to(roomName).emit('notify', text);
    };
    const removeSpecificRoleFromIndex = (room, playerIndex, role) => {
        const player = room.players[playerIndex];
        if (!player) return false;
        const idx = player.cards.indexOf(role);
        if (idx === -1) return false;
        player.cards.splice(idx, 1);
        return true;
    };

    const advanceTurn = (room) => {
        if (room.players.length === 0) return;
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        let guard = 0;
        while (room.players[room.turnIndex]?.status !== 'playing' && guard < 50) {
            room.turnIndex = (room.turnIndex + 1) % room.players.length;
            guard++;
        }
    };

    const removeOneCardFromIndex = (room, playerIndex) => {
        const target = room.players[playerIndex];
        if (!target) return null;
        const removed = target.cards.pop();
        if (removed) {
            target.lostReveals = Array.isArray(target.lostReveals) ? target.lostReveals : [];
            target.lostReveals.push(removed);
        }
        if (target.cards.length === 0) {
            target.status = 'out';
            room.players.splice(playerIndex, 1);
            if (room.turnIndex > playerIndex) room.turnIndex--;
            if (room.turnIndex >= room.players.length) room.turnIndex = 0;
        }
        checkVictory(room);
        return removed;
    };

    const ensureDeckHasCards = (room, count = 1) => {
        if (room.deck.length >= count) return;
        const chars = ['ASSASSINO', 'DUQUE', 'CAPITAO', 'CONDESSA', 'EMBAIXADOR'];
        const add = count - room.deck.length + 5;
        for (let i = 0; i < add; i++) {
            room.deck.push(chars[i % chars.length]);
        }
        room.deck.sort(() => Math.random() - 0.5);
    };
    const checkVictory = (room) => {
        if (!room.gameStarted) return;
        const alive = room.players.filter(p => p.status === 'playing');
        if (alive.length === 1) {
            room.gameStarted = false;
            room.winnerId = alive[0].id;
            room.pendingAction = null;
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
        }
    };

    // Eventos novos — mantenha dentro do bloco de conexão
    socket.on('declareAction', ({ roomName, action, targetId }) => {
        const room = rooms[roomName];
        if (!room) return socket.emit('error', 'Sala não encontrada');

        const actor = room.players[room.turnIndex];
        if (!actor || actor.id !== socket.id) {
            return socket.emit('error', 'Não é seu turno');
        }

        // Regra: com 10+ moedas, somente Golpe de Estado é permitido
        if (actor.coins >= 10) {
            return socket.emit('error', 'Com 10+ moedas, você deve realizar Golpe de Estado');
        }

        // custo e elegibilidade básica
        if (action === 'assassinate') {
            if (actor.coins < 3) return socket.emit('error', 'Assassinar custa 3 moedas');
            actor.coins -= 3;
        }

        // Ajuda Externa: cria ação pendente com timer para bloqueio
        if (action === 'foreign_aid') {
            // limpa timer anterior, se existir
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }

            room.pendingAction = {
                type: 'foreign_aid',
                actorId: actor.id,
                targetId: null,
                block: null,
                challenged: null,
                expiresAt: Date.now() + 15000,
                agreements: []
            };

            // Auto-finaliza em 15s se ninguém bloquear
            room.pendingTimer = setTimeout(() => {
                const p = room.pendingAction;
                if (p && p.type === 'foreign_aid' && !p.block) {
                    const aIndex = room.players.findIndex(pl => pl.id === p.actorId);
                    if (aIndex !== -1) {
                        room.players[aIndex].coins += 2;
                    }
                    room.pendingAction = null;
                    advanceTurn(room);
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
                room.pendingTimer = null;
            }, 15000);

            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        }

        if (action === 'tax') {
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            room.pendingAction = {
                type: 'tax',
                actorId: actor.id,
                targetId: null,
                block: null,
                challenged: null,
                expiresAt: Date.now() + 15000,
                agreements: []
            };
            notify(roomName, `O jogador ${actor.name} solicitou Receber 3 Moedas — clique em Contestar se discordar.`);
            room.pendingTimer = setTimeout(() => {
                const p = room.pendingAction;
                if (p && p.type === 'tax' && !p.challenged) {
                    const aIndex = room.players.findIndex(pl => pl.id === p.actorId);
                    if (aIndex !== -1) {
                        room.players[aIndex].coins += 3;
                    }
                    room.pendingAction = null;
                    advanceTurn(room);
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
                room.pendingTimer = null;
            }, 15000);
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        }

        if (action === 'exchange') {
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            room.pendingAction = {
                type: 'exchange',
                actorId: actor.id,
                targetId: null,
                block: null,
                challenged: null,
                expiresAt: Date.now() + 15000,
                agreements: []
            };
            notify(roomName, `O jogador ${actor.name} declarou Trocar Cartas — clique em Contestar ou Permitir.`);
            room.pendingTimer = setTimeout(() => {
                const p = room.pendingAction;
                if (p && p.type === 'exchange' && !p.challenged) {
                    const aIndex = room.players.findIndex(pl => pl.id === p.actorId);
                    if (aIndex !== -1) {
                        ensureDeckHasCards(room, 2);
                        const newCards = [room.deck.pop(), room.deck.pop()];
                        const pool = [...room.players[aIndex].cards, ...newCards];
                        pool.sort(() => Math.random() - 0.5);
                        room.pendingAction = { type: 'exchange_choice', actorId: p.actorId, pool };
                        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    } else {
                        room.pendingAction = null;
                        advanceTurn(room);
                        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    }
                }
                room.pendingTimer = null;
            }, 15000);
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        } else if (action === 'assassinate') {
            if (!targetId) return socket.emit('error', 'Selecione um alvo para Assassinar');
            // janela para bloqueio/contestação; se ninguém agir, executa
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            room.pendingAction = { type: 'assassinate', actorId: actor.id, targetId, block: null, challenged: null, expiresAt: Date.now() + 15000 };
            const targetName = room.players.find(p => p.id === targetId)?.name || '';
            notify(roomName, `O jogador ${actor.name} está assassinando o jogador ${targetName}.`);
            room.pendingTimer = setTimeout(() => {
                const p = room.pendingAction;
                if (p && p.type === 'assassinate' && !p.block && !p.challenged) {
                    const tIndex = room.players.findIndex(pl => pl.id === p.targetId);
                    if (tIndex !== -1) {
                        room.pendingAction = {
                            type: 'loss_choice',
                            source: 'assassinate',
                            actorId: room.players[tIndex].id,
                            initiatorId: p.actorId,
                            targetId: null,
                            block: null,
                            challenged: null
                        };
                        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    } else {
                        room.pendingAction = null;
                        advanceTurn(room);
                        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    }
                }
                room.pendingTimer = null;
            }, 15000);
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        } else if (action === 'steal') {
            if (!targetId) return socket.emit('error', 'Selecione um alvo para Roubar');
            room.pendingAction = { type: 'steal', actorId: actor.id, targetId, block: null, challenged: null, agreements: [] };
            const targetName = room.players.find(p => p.id === targetId)?.name || '';
            notify(roomName, `O jogador ${actor.name} está extorquindo 2 moedas do jogador ${targetName}.`);
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
        } else {
            room.pendingAction = { type: action, actorId: actor.id, targetId: targetId || null, block: null, challenged: null };
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
        }
    });

    socket.on('challengeAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        // Contestação de "Receber 3 Moedas"
        if (pending.type === 'tax') {
            if (socket.id === pending.actorId) return socket.emit('error', 'Ator não pode contestar a própria ação');
            const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
            if (actorIndex === -1) return;
            const actor = room.players[actorIndex];
            const challengerIndex = room.players.findIndex(p => p.id === socket.id);
            if (challengerIndex === -1) return;
            const challenger = room.players[challengerIndex];

            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }

            pending.challenged = { byId: socket.id, kind: 'action' };
            notify(roomName, `O jogador ${challenger.name} contestou. ${actor.name} deve provar que é o DUQUE.`);

            const actorHasDuke = actor.cards.includes('DUQUE');
            if (actorHasDuke) {
                const removed = removeSpecificRoleFromIndex(room, actorIndex, 'DUQUE');
                if (removed) {
                    room.deck.push('DUQUE');
                    room.deck.sort(() => Math.random() - 0.5);
                    ensureDeckHasCards(room, 1);
                    const newCard = room.deck.pop();
                    actor.cards.push(newCard);
                }
                actor.coins += 3;
                notify(roomName, `O jogador ${actor.name} era o DUQUE. Carta revelada, devolvida ao baralho e nova carta recebida.`);
                // Se o contestador tem apenas 1 carta, é eliminado imediatamente
                const challengerCards = room.players[challengerIndex]?.cards || [];
                if (challengerCards.length <= 1) {
                    removeOneCardFromIndex(room, challengerIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${challenger.name} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'tax',
                        actorId: challenger.id,
                        initiatorId: actor.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            } else {
                notify(roomName, `O jogador ${actor.name} não é o DUQUE. Escolha uma carta para perder.`);
                // Se o ator tem apenas 1 carta, é eliminado imediatamente
                const actorCards = actor.cards || [];
                if (actorCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${actor.name} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'tax',
                        actorId: actor.id,
                        initiatorId: challenger.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            }
            return;
        }
        // Contestação de "Assassinar"
        if (pending.type === 'assassinate') {
            if (socket.id === pending.actorId) return socket.emit('error', 'Ator não pode contestar a própria ação');
            const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
            const targetIndex = room.players.findIndex(p => p.id === pending.targetId);
            if (actorIndex === -1) return;
            const actor = room.players[actorIndex];
            const challengerIndex = room.players.findIndex(p => p.id === socket.id);
            if (challengerIndex === -1) return;
            const challenger = room.players[challengerIndex];

            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }

            pending.challenged = { byId: socket.id, kind: 'action' };
            notify(roomName, `O jogador ${challenger.name} contestou. ${actor.name} deve provar que é o ASSASSINO.`);

            const actorHasAssassin = actor.cards.includes('ASSASSINO');
            if (actorHasAssassin) {
                const removed = removeSpecificRoleFromIndex(room, actorIndex, 'ASSASSINO');
                if (removed) {
                    room.deck.push('ASSASSINO');
                    room.deck.sort(() => Math.random() - 0.5);
                    ensureDeckHasCards(room, 1);
                    const newCard = room.deck.pop();
                    actor.cards.push(newCard);
                }
                notify(roomName, `O jogador ${actor.name} era o ASSASSINO. Carta revelada, devolvida ao baralho e nova carta recebida.`);
                if (targetIndex !== -1) {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'assassinate',
                        actorId: room.players[targetIndex].id,
                        initiatorId: actor.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                    const targetName = room.players[targetIndex]?.name || '';
                    notify(roomName, `${targetName} deve escolher uma carta para perder.`);
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = null;
                    advanceTurn(room);
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            } else {
                // Ator falhou: perde carta
                notify(roomName, `O jogador ${actor.name} não é o ASSASSINO. Escolha uma carta para perder.`);
                const actorCards = actor.cards || [];
                if (actorCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${actor.name} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'assassinate',
                        actorId: actor.id,
                        initiatorId: challenger.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            }
            return;
        }
        // Contestação de "Trocar Cartas" — ator deve provar EMBAIXADOR
        if (pending.type === 'exchange') {
            if (socket.id === pending.actorId) return socket.emit('error', 'Ator não pode contestar a própria ação');
            const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
            if (actorIndex === -1) return;
            const actor = room.players[actorIndex];
            const challengerIndex = room.players.findIndex(p => p.id === socket.id);
            if (challengerIndex === -1) return;
            const challenger = room.players[challengerIndex];
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            pending.challenged = { byId: socket.id, kind: 'action' };
            notify(roomName, `O jogador ${challenger.name} contestou. ${actor.name} deve provar que é o EMBAIXADOR.`);
            const actorHas = actor.cards.includes('EMBAIXADOR');
            if (actorHas) {
                const removed = removeSpecificRoleFromIndex(room, actorIndex, 'EMBAIXADOR');
                if (removed) {
                    room.deck.push('EMBAIXADOR');
                    room.deck.sort(() => Math.random() - 0.5);
                    ensureDeckHasCards(room, 1);
                    const newCard = room.deck.pop();
                    actor.cards.push(newCard);
                }
                ensureDeckHasCards(room, 2);
                const newCards = [room.deck.pop(), room.deck.pop()];
                const pool = [...actor.cards, ...newCards];
                pool.sort(() => Math.random() - 0.5);
                room.pendingAction = { type: 'exchange_choice', actorId: actor.id, pool };
                notify(roomName, `O jogador ${actor.name} era o EMBAIXADOR. Carta revelada, devolvida ao baralho e nova carta recebida.`);
                // contestador perde carta
                const chCards = room.players[challengerIndex]?.cards || [];
                if (chCards.length <= 1) {
                    removeOneCardFromIndex(room, challengerIndex);
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'exchange',
                        actorId: room.players[challengerIndex].id,
                        initiatorId: actor.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                }
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            } else {
                // ator falhou: perde carta e ação é cancelada
                notify(roomName, `O jogador ${actor.name} não é o EMBAIXADOR. Escolha uma carta para perder.`);
                const aCards = actor.cards || [];
                if (aCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${actor.name} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'exchange',
                        actorId: actor.id,
                        initiatorId: room.players[challengerIndex].id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'action' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            }
            return;
        }
    });
    socket.on('permitAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        if (!['tax','steal','foreign_aid','assassinate','exchange'].includes(pending.type)) return;
        // apenas não-atores podem permitir
        if (pending.type !== 'assassinate' && socket.id === pending.actorId) return;
        if (pending.type === 'assassinate' && socket.id !== pending.targetId) return;
        // se já houve contestação, não processa permissão
        if (pending.challenged || pending.block) return;
        // registra consentimento único
        if (pending.type === 'assassinate') {
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            const tIndex = room.players.findIndex(p => p.id === pending.targetId);
            if (tIndex !== -1) {
                const target = room.players[tIndex];
                const targetCards = target?.cards || [];
                if (targetCards.length <= 1) {
                    removeOneCardFromIndex(room, tIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${target?.name || ''} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'assassinate',
                        actorId: pending.targetId,
                        initiatorId: pending.actorId,
                        targetId: null,
                        block: null,
                        challenged: null
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            }
            return;
        }
        pending.agreements = Array.isArray(pending.agreements) ? pending.agreements : [];
        if (!pending.agreements.includes(socket.id)) {
            pending.agreements.push(socket.id);
        }
        const activeOthers = room.players
            .filter(p => p.status === 'playing' && p.id !== pending.actorId)
            .map(p => p.id);
        const allAgreed = activeOthers.every(id => pending.agreements.includes(id));
        if (allAgreed) {
            if (pending.type === 'tax') {
                const aIndex = room.players.findIndex(pl => pl.id === pending.actorId);
                if (aIndex !== -1) {
                    room.players[aIndex].coins += 3;
                }
            } else if (pending.type === 'steal') {
                const aIndex = room.players.findIndex(pl => pl.id === pending.actorId);
                const tIndex = room.players.findIndex(p => p.id === pending.targetId);
                if (aIndex !== -1 && tIndex !== -1) {
                    const actor = room.players[aIndex];
                    const target = room.players[tIndex];
                    const stolen = Math.min(2, target.coins);
                    target.coins -= stolen;
                    actor.coins += stolen;
                }
            } else if (pending.type === 'foreign_aid') {
                const aIndex = room.players.findIndex(pl => pl.id === pending.actorId);
                if (aIndex !== -1) {
                    room.players[aIndex].coins += 2;
                }
            } else if (pending.type === 'exchange') {
                const aIndex = room.players.findIndex(pl => pl.id === pending.actorId);
                if (aIndex !== -1) {
                    ensureDeckHasCards(room, 2);
                    const newCards = [room.deck.pop(), room.deck.pop()];
                    const pool = [...room.players[aIndex].cards, ...newCards];
                    pool.sort(() => Math.random() - 0.5);
                    room.pendingAction = { type: 'exchange_choice', actorId: pending.actorId, pool };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                    // não avança turno ainda — aguarda escolha de devolução
                    return;
                }
            }
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            if (pending.type !== 'exchange') {
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            }
        } else {
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
        }
    });

    socket.on('blockAction', ({ roomName, role }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;

        // Ajuda Externa: qualquer jogador (exceto o ator) pode bloquear como DUQUE
        if (pending.type === 'foreign_aid') {
            if (socket.id === pending.actorId) return socket.emit('error', 'Ator não pode bloquear a própria ação');
            if (role !== 'DUQUE') return socket.emit('error', 'Bloqueio de Ajuda Externa exige DUQUE');

            pending.block = { blockerId: socket.id, role: 'DUQUE' };

            // cancelar o timer de pendência
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }

            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        }
        // Roubo: qualquer não-ator pode bloquear (prova posterior CAPITAO/EMBAIXADOR)
        if (pending.type === 'steal') {
            if (socket.id === pending.actorId) return socket.emit('error', 'Ator não pode bloquear a própria ação');
            pending.block = { blockerId: socket.id, role: 'STEAL_BLOCK' };
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        }

        // Demais ações: somente o alvo pode bloquear
        const isTarget = pending.targetId === socket.id;
        if (!isTarget) return socket.emit('error', 'Somente o alvo pode bloquear');

        if (pending.type === 'assassinate') {
            if (role !== 'CONDESSA') return socket.emit('error', 'Bloqueio exige CONDESSA');
        } else {
            return socket.emit('error', 'Esta ação não pode ser bloqueada');
        }

        pending.block = { blockerId: socket.id, role };
        if (room.pendingTimer) {
            clearTimeout(room.pendingTimer);
            room.pendingTimer = null;
        }
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });

    socket.on('challengeBlock', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction?.block) return;
        const pending = room.pendingAction;
        const block = pending.block;
        const actorIndex = room.players.findIndex(p => p.id === pending.actorId);

        // Em Ajuda Externa, somente o ator pode contestar o bloqueio
        if (pending.type === 'foreign_aid' && socket.id !== pending.actorId) {
            return socket.emit('error', 'Somente o ator pode contestar este bloqueio');
        }

        const challengerIndex = room.players.findIndex(p => p.id === socket.id);
        if (challengerIndex === -1) return;

        const blockerIndex = room.players.findIndex(p => p.id === block.blockerId);
        if (blockerIndex === -1) return;

        const blocker = room.players[blockerIndex];
        const actor = room.players[actorIndex];
        const challenger = room.players[challengerIndex];
        const actionLabel =
            pending.type === 'foreign_aid' ? 'Ajuda Externa' :
            pending.type === 'assassinate' ? 'Assassinar' :
            pending.type === 'steal' ? 'Roubar' : 'Trocar Cartas';
        notify(roomName, `O jogador ${challenger.name} contestou o bloqueio de ${blocker.name} na ação ${actionLabel} de ${actor.name}.`);

        const blockerHasRole =
            pending.type === 'steal'
                ? (blocker.cards.includes('EMBAIXADOR') || blocker.cards.includes('CAPITAO'))
                : blocker.cards.includes(block.role);

        pending.challenged = { byId: socket.id, kind: 'block' };

        // Caso bloqueador prove DUQUE no bloqueio de Ajuda Externa
        if (pending.type === 'foreign_aid') {
            if (blockerHasRole) {
                const removed = removeSpecificRoleFromIndex(room, blockerIndex, 'DUQUE');
                if (removed) {
                    room.deck.push('DUQUE');
                    room.deck.sort(() => Math.random() - 0.5);
                    ensureDeckHasCards(room, 1);
                    const newCard = room.deck.pop();
                    room.players[blockerIndex].cards.push(newCard);
                }
                notify(roomName, `Bloqueio confirmado: ${blocker.name} provou DUQUE. ${actor.name} deve perder uma carta.`);
                // Se o ator tem apenas 1 carta, elimina imediatamente
                const actor = room.players[actorIndex];
                const actorCards = actor?.cards || [];
                if (actorCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${actor?.name || ''} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'foreign_aid',
                        actorId: pending.actorId,
                        initiatorId: blockerIndex !== -1 ? room.players[blockerIndex].id : null,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'block' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            } else {
                // Bloqueador falhou: perde carta e bloqueio é removido
                removeOneCardFromIndex(room, blockerIndex);
                // Finaliza imediatamente a Ajuda Externa (+2) e avança o turno
                const actor = room.players[actorIndex];
                if (actor) {
                    actor.coins += 2;
                }
                notify(roomName, `Bloqueio falhou: ${blocker.name} não provou DUQUE. ${actor.name} recebeu +2 moedas.`);
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            }
            return;
        }

        if (pending.type === 'assassinate') {
            // Ator contesta bloqueio da CONDESSA
            const blockerHasRole = room.players[blockerIndex]?.cards.includes('CONDESSA');
            if (blockerHasRole) {
                // Bloqueio provado: ator perde carta
                notify(roomName, `Bloqueio confirmado: ${blocker.name} provou CONDESSA. ${actor.name} deve perder uma carta.`);
                const actorCards = room.players[actorIndex]?.cards || [];
                if (actorCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${room.players[actorIndex]?.name || ''} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'assassinate_block',
                        actorId: pending.actorId,
                        initiatorId: room.players[blockerIndex]?.id || null,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'block' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
            } else {
                // Bloqueio falhou: alvo perde carta
                const targetName = room.players.find(p => p.id === pending.targetId)?.name || '';
                notify(roomName, `Bloqueio falhou: ${blocker.name} não provou CONDESSA. ${targetName} deve perder uma carta.`);
                const tIndex = room.players.findIndex(p => p.id === pending.targetId);
                if (tIndex !== -1) removeOneCardFromIndex(room, tIndex);
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            }
            return;
        }

        if (pending.type === 'steal') {
            if (socket.id !== pending.actorId) return socket.emit('error', 'Somente o ator pode contestar este bloqueio');
            const tIndex = room.players.findIndex(p => p.id === pending.targetId);
            if (blockerHasRole) {
                const actor = room.players[actorIndex];
                const actorCards = actor?.cards || [];
                notify(roomName, `Bloqueio confirmado: ${blocker.name} provou ${block.role === 'STEAL_BLOCK' ? 'EMBAIXADOR/CAPITAO' : block.role}. ${actor.name} deve perder uma carta.`);
                if (actorCards.length <= 1) {
                    removeOneCardFromIndex(room, actorIndex);
                    room.pendingAction = null;
                    if (room.gameStarted) {
                        notify(roomName, `O jogador ${actor?.name || ''} foi eliminado do jogo.`);
                        advanceTurn(room);
                    }
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                } else {
                    room.pendingAction = {
                        type: 'loss_choice',
                        source: 'steal',
                        actorId: pending.actorId,
                        initiatorId: blocker.id,
                        targetId: null,
                        block: null,
                        challenged: { byId: socket.id, kind: 'block' }
                    };
                    io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                }
                return;
            } else {
                removeOneCardFromIndex(room, blockerIndex);
                if (tIndex !== -1) {
                    const actor = room.players[actorIndex];
                    const target = room.players[tIndex];
                    const stolen = Math.min(2, target.coins);
                    target.coins -= stolen;
                    actor.coins += stolen;
                    notify(roomName, `Bloqueio falhou: ${blocker.name} não provou EMBAIXADOR/CAPITAO. ${actor.name} roubou ${stolen} moedas de ${target.name}.`);
                }
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
                return;
            }
        }

        if (pending.type === 'exchange') {
            const actor = room.players[actorIndex];
            ensureDeckHasCards(room, 2);
            const newCards = [room.deck.pop(), room.deck.pop()];
            const pool = [...actor.cards, ...newCards];
            pool.sort(() => Math.random() - 0.5);
            actor.cards = [pool[0], pool[1]];
            room.deck.push(pool[2], pool[3]);
            room.deck.sort(() => Math.random() - 0.5);
        }

        room.pendingAction = null;
        advanceTurn(room);
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });

    // Ator pode cancelar a ação pendente (após bloqueio)
    socket.on('cancelAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        if (pending.actorId !== socket.id) return socket.emit('error', 'Somente o ator pode cancelar');

        // limpa timer se existir
        if (room.pendingTimer) {
            clearTimeout(room.pendingTimer);
            room.pendingTimer = null;
        }

        room.pendingAction = null;
        advanceTurn(room);
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });

    socket.on('finalizeAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;

        const pending = room.pendingAction;
        const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
        if (actorIndex === -1 || room.players[actorIndex].id !== socket.id) {
            return socket.emit('error', 'Somente o ator pode finalizar');
        }
        if (pending.block) return socket.emit('error', 'Ação bloqueada — conteste ou cancele');
        if (pending.type === 'loss_choice') {
            return socket.emit('error', 'Escolha uma carta para perder');
        }

        // Ajuda Externa: ganha +2 moedas se não houver bloqueio
        if (pending.type === 'foreign_aid') {
            room.players[actorIndex].coins += 2;
            room.pendingAction = null;
            advanceTurn(room);
            io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
            return;
        }
        if (pending.type === 'tax') {
            return socket.emit('error', 'Ação aguarda consenso/contestação — sem confirmação do ator');
        }
        if (pending.type === 'steal') {
            return socket.emit('error', 'Ação aguarda Permitir/Bloquear — sem confirmação do ator');
        }

        if (pending.type === 'assassinate') {
            return socket.emit('error', 'Ação aguarda bloquear/contestar — sem confirmação do ator');
        }

        // Steal não é finalizado pelo ator — verificado acima

        if (pending.type === 'exchange') {
            const actor = room.players[actorIndex];
            ensureDeckHasCards(room, 2);
            const newCards = [room.deck.pop(), room.deck.pop()];
            const pool = [...actor.cards, ...newCards];
            pool.sort(() => Math.random() - 0.5);
            actor.cards = [pool[0], pool[1]];
            room.deck.push(pool[2], pool[3]);
            room.deck.sort(() => Math.random() - 0.5);
        }

        room.pendingAction = null;
        advanceTurn(room);
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });

    socket.on('chooseExchangeReturn', ({ roomName, roles }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction || room.pendingAction.type !== 'exchange_choice') return;
        const pending = room.pendingAction;
        if (socket.id !== pending.actorId) return;
        const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
        if (actorIndex === -1) return;
        const pool = pending.pool || [];
        const toReturn = Array.isArray(roles) ? roles.slice(0, 2) : [];
        const keep = [];
        const deckReturn = [];
        for (const c of pool) {
            if (toReturn.includes(c) && deckReturn.length < 2) deckReturn.push(c);
            else keep.push(c);
        }
        const actor = room.players[actorIndex];
        actor.cards = keep.slice(0, 2);
        room.deck.push(...deckReturn);
        room.deck.sort(() => Math.random() - 0.5);
        room.pendingAction = null;
        advanceTurn(room);
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });
    socket.on('chooseLossCard', ({ roomName, role }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction || room.pendingAction.type !== 'loss_choice') return;
        const actorId = room.pendingAction.actorId;
        const initiatorId = room.pendingAction.initiatorId;
        const source = room.pendingAction.source || null;
        if (socket.id !== actorId) return;
        const idx = room.players.findIndex(p => p.id === actorId);
        if (idx === -1) return;
        const actorName = room.players[idx]?.name || '';
        const initiatorName = room.players.find(p => p.id === initiatorId)?.name || '';
        const ok = removeSpecificRoleFromIndex(room, idx, role);
        if (!ok) removeOneCardFromIndex(room, idx);
        else {
            room.players[idx].lostReveals = Array.isArray(room.players[idx].lostReveals) ? room.players[idx].lostReveals : [];
            room.players[idx].lostReveals.push(role);
        }
        room.pendingAction = null;
        checkVictory(room);
        if (room.gameStarted) {
            const stillIn = room.players.find(p => p.id === actorId);
            if (!stillIn || stillIn.status === 'out') {
                if (source === 'coup') {
                    notify(roomName, `O JOGADOR ${initiatorName} ACABA DE DAR UM GOLPE DE ESTADO NO JOGADOR ${actorName} E ELE FOI ELIMINADO DO JOGO.`);
                } else {
                    notify(roomName, `O jogador ${actorName} foi eliminado do jogo.`);
                }
            } else {
                if (source === 'coup') {
                    notify(roomName, `O JOGADOR ${initiatorName} ACABA DE DAR UM GOLPE DE ESTADO NO JOGADOR ${actorName} E ELE ACABA DE PERDER UM PERSONAGEM.`);
                } else {
                    notify(roomName, `O jogador ${actorName} perdeu um personagem.`);
                }
            }
            advanceTurn(room);
        }
        io.to(roomName).emit('gameStateUpdate', sanitizeRoom(room));
    });
    socket.on('rtcOffer', ({ roomName, targetId, sdp }) => {
        if (!rooms[roomName]) return;
        io.to(targetId).emit('rtcOffer', { fromId: socket.id, sdp });
    });
    socket.on('rtcAnswer', ({ roomName, targetId, sdp }) => {
        if (!rooms[roomName]) return;
        io.to(targetId).emit('rtcAnswer', { fromId: socket.id, sdp });
    });
    socket.on('rtcCandidate', ({ roomName, targetId, candidate }) => {
        if (!rooms[roomName]) return;
        io.to(targetId).emit('rtcCandidate', { fromId: socket.id, candidate });
    });
    socket.on('rtcEnd', ({ roomName }) => {
        if (!rooms[roomName]) return;
        socket.to(roomName).emit('rtcPeerLeft', { peerId: socket.id });
    });
}); // mantenha apenas este fechamento final

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Backend rodando na porta ' + PORT));
