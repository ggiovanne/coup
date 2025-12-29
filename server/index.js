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

    // Atualiza a lista para todos (útil se você mostrar contagem/estado das salas)
    io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));


    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        if (room.players.length < 2) return;

        // Lógica do Deck dinâmico
        const pCount = room.players.length;
        let cardsPerChar = pCount <= 4 ? 3 : (pCount <= 7 ? 4 : 5);
        const chars = ['ASSASSINO', 'DUQUE', 'CAPITAO', 'CONDESSA', 'EMBAIXADOR'];
        room.deck = [];
        chars.forEach(c => {
            for(let i=0; i<cardsPerChar; i++) room.deck.push(c);
        });
        
        // Shuffle e Distribuir
        room.deck.sort(() => Math.random() - 0.5);
        room.players.forEach(p => {
            p.cards = [room.deck.pop(), room.deck.pop()];
            p.status = 'playing';
        });

        room.gameStarted = true;
        room.turnIndex = Math.floor(Math.random() * room.players.length);
        io.to(roomName).emit('gameStateUpdate', room);
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
                io.to(roomName).emit('gameStateUpdate', room);
                break;
            }
            case 'foreign_aid': {
                // Ajuda Externa deve ser declarada para permitir bloqueio/contestação
                return socket.emit('error', 'Ajuda Externa deve ser declarada (pode ser bloqueada por DUQUE)');
            }
            case 'tax': {
                const hasDuke = current.cards.includes('DUQUE');
                if (!hasDuke) return socket.emit('error', 'Imposto exige possuir DUQUE');
                current.coins += 3;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', room);
                break;
            }
            case 'coup': {
                if (current.coins < 7) return socket.emit('error', 'Coup custa 7 moedas');
                const targetIndex = room.players.findIndex(p => p.id === targetId);
                if (targetIndex === -1 || room.players[targetIndex]?.id === current.id) {
                    return socket.emit('error', 'Alvo inválido para Coup');
                }
                current.coins -= 7;
                removeOneCardFrom(targetIndex);
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', room);
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
                io.to(name).emit('gameStateUpdate', room);
            }
        }
        io.emit('updateRooms', Object.values(rooms).map(r => ({ name: r.name, hasPass: !!r.password })));
    });

    // Helpers reutilizáveis — mantenha dentro do bloco de conexão
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
        if (!target) return;
        target.cards.pop();
        if (target.cards.length === 0) {
            target.status = 'out';
            room.players.splice(playerIndex, 1);
            if (room.turnIndex > playerIndex) room.turnIndex--;
            if (room.turnIndex >= room.players.length) room.turnIndex = 0;
        }
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
                expiresAt: Date.now() + 15000
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
                    io.to(roomName).emit('gameStateUpdate', room);
                }
                room.pendingTimer = null;
            }, 15000);

            io.to(roomName).emit('gameStateUpdate', room);
            return;
        }

        // Demais ações já suportadas
        room.pendingAction = {
            type: action,
            actorId: actor.id,
            targetId: targetId || null,
            block: null,
            challenged: null,
            agreements: [],
        };

        if (action === 'tax') {
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            const eligibleIds = room.players
                .filter(p => p.status === 'playing' && p.id !== actor.id)
                .map(p => p.id);
            if (eligibleIds.length === 0) {
                const aIndex = room.players.findIndex(pl => pl.id === actor.id);
                if (aIndex !== -1) {
                    room.players[aIndex].coins += 3;
                }
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', room);
                return;
            }
            room.pendingAction.expiresAt = Date.now() + 15000;
            room.pendingTimer = setTimeout(() => {
                const p = room.pendingAction;
                if (p && p.type === 'tax' && !p.challenged) {
                    const aIndex = room.players.findIndex(pl => pl.id === p.actorId);
                    if (aIndex !== -1) {
                        room.players[aIndex].coins += 3;
                    }
                    room.pendingAction = null;
                    advanceTurn(room);
                    io.to(roomName).emit('gameStateUpdate', room);
                }
                room.pendingTimer = null;
            }, 15000);
        }

        io.to(roomName).emit('gameStateUpdate', room);
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

            io.to(roomName).emit('gameStateUpdate', room);
            return;
        }

        // Demais ações: somente o alvo pode bloquear
        const isTarget = pending.targetId === socket.id;
        if (!isTarget) return socket.emit('error', 'Somente o alvo pode bloquear');

        if (pending.type === 'assassinate') {
            if (role !== 'CONDESSA') return socket.emit('error', 'Bloqueio exige CONDESSA');
        } else if (pending.type === 'steal') {
            if (!['EMBAIXADOR', 'CAPITAO'].includes(role)) {
                return socket.emit('error', 'Bloqueio de roubo exige EMBAIXADOR ou CAPITAO');
            }
        } else {
            return socket.emit('error', 'Esta ação não pode ser bloqueada');
        }

        pending.block = { blockerId: socket.id, role };
        io.to(roomName).emit('gameStateUpdate', room);
    });

    socket.on('permitAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        const actorId = pending.actorId;
        if (socket.id === actorId) return;
        if (!['tax','exchange'].includes(pending.type)) return;
        if (!pending.agreements) pending.agreements = [];
        if (!pending.agreements.includes(socket.id)) pending.agreements.push(socket.id);

        const eligibleIds = room.players
            .filter(p => p.status === 'playing' && p.id !== actorId)
            .map(p => p.id);
        const allPermitted = eligibleIds.every(id => pending.agreements.includes(id));

        if (allPermitted) {
            if (room.pendingTimer) {
                clearTimeout(room.pendingTimer);
                room.pendingTimer = null;
            }
            if (pending.type === 'tax') {
                const aIndex = room.players.findIndex(pl => pl.id === actorId);
                if (aIndex !== -1) room.players[aIndex].coins += 3;
            }
            room.pendingAction = null;
            advanceTurn(room);
        }
        io.to(roomName).emit('gameStateUpdate', room);
    });

    socket.on('challengeAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        if (socket.id === pending.actorId) return;

        if (pending.type !== 'tax') return;

        const challengerIndex = room.players.findIndex(p => p.id === socket.id);
        const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
        if (challengerIndex === -1 || actorIndex === -1) return;

        pending.challenged = { byId: socket.id, kind: 'action' };

        const actor = room.players[actorIndex];
        const actorHasDuke = actor.cards.includes('DUQUE');

        if (room.pendingTimer) {
            clearTimeout(room.pendingTimer);
            room.pendingTimer = null;
        }

        if (actorHasDuke) {
            removeOneCardFromIndex(room, challengerIndex);
            const removed = removeSpecificRoleFromIndex(room, actorIndex, 'DUQUE');
            if (removed) {
                room.deck.push('DUQUE');
                room.deck.sort(() => Math.random() - 0.5);
                ensureDeckHasCards(room, 1);
                const newCard = room.deck.pop();
                room.players[actorIndex].cards.push(newCard);
            }
            room.players[actorIndex].coins += 3;
            room.pendingAction = null;
            advanceTurn(room);
            io.to(roomName).emit('gameStateUpdate', room);
        } else {
            removeOneCardFromIndex(room, actorIndex);
            room.pendingAction = null;
            advanceTurn(room);
            io.to(roomName).emit('gameStateUpdate', room);
        }
    });
    socket.on('challengeBlock', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction?.block) return;
        const pending = room.pendingAction;
        const block = pending.block;

        // Em Ajuda Externa, somente o ator pode contestar o bloqueio
        if (pending.type === 'foreign_aid' && socket.id !== pending.actorId) {
            return socket.emit('error', 'Somente o ator pode contestar este bloqueio');
        }

        const challengerIndex = room.players.findIndex(p => p.id === socket.id);
        if (challengerIndex === -1) return;

        const blockerIndex = room.players.findIndex(p => p.id === block.blockerId);
        if (blockerIndex === -1) return;

        const blocker = room.players[blockerIndex];
        const blockerHasRole = blocker.cards.includes(block.role);

        pending.challenged = { byId: socket.id, kind: 'block' };

        // Caso bloqueador prove DUQUE no bloqueio de Ajuda Externa
        if (pending.type === 'foreign_aid') {
            if (blockerHasRole) {
                // Ator perde uma carta
                const actorIndex = room.players.findIndex(p => p.id === pending.actorId);
                if (actorIndex !== -1) removeOneCardFromIndex(room, actorIndex);

                // Bloqueador descarta DUQUE, devolve ao baralho e compra outra carta
                const removed = removeSpecificRoleFromIndex(room, blockerIndex, 'DUQUE');
                if (removed) {
                    room.deck.push('DUQUE');        // devolve DUQUE ao baralho
                    room.deck.sort(() => Math.random() - 0.5);
                    ensureDeckHasCards(room, 1);
                    const newCard = room.deck.pop();
                    room.players[blockerIndex].cards.push(newCard);
                }

                // Encerra a ação sem ganhar moedas e avança turno
                room.pendingAction = null;
                advanceTurn(room);
                io.to(roomName).emit('gameStateUpdate', room);
            } else {
                // Bloqueador falhou: perde carta e bloqueio é removido
                removeOneCardFromIndex(room, blockerIndex);
                pending.block = null;
                io.to(roomName).emit('gameStateUpdate', room);
            }
        }
        });

    socket.on('cancelAction', ({ roomName }) => {
        const room = rooms[roomName];
        if (!room?.pendingAction) return;
        const pending = room.pendingAction;
        if (socket.id !== pending.actorId) return socket.emit('error', 'Somente o ator pode cancelar');

        // limpa timer se existir
        if (room.pendingTimer) {
            clearTimeout(room.pendingTimer);
            room.pendingTimer = null;
        }

        room.pendingAction = null;
        advanceTurn(room);
        io.to(roomName).emit('gameStateUpdate', room);
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

        // Ajuda Externa: ganha +2 moedas se não houver bloqueio
        if (pending.type === 'foreign_aid') {
            room.players[actorIndex].coins += 2;
            room.pendingAction = null;
            advanceTurn(room);
            io.to(roomName).emit('gameStateUpdate', room);
            return;
        }

        if (pending.type === 'assassinate') {
            const tIndex = room.players.findIndex(p => p.id === pending.targetId);
            if (tIndex === -1) {
                room.pendingAction = null;
                io.to(roomName).emit('gameStateUpdate', room);
                return;
            }
            removeOneCardFromIndex(room, tIndex);
        }

        if (pending.type === 'steal') {
            const tIndex = room.players.findIndex(p => p.id === pending.targetId);
            if (tIndex !== -1) {
                const actor = room.players[actorIndex];
                const target = room.players[tIndex];
                const stolen = Math.min(2, target.coins);
                target.coins -= stolen;
                actor.coins += stolen;
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
        io.to(roomName).emit('gameStateUpdate', room);
    });
}); // mantenha apenas este fechamento final

server.listen(process.env.PORT || 3001, () => console.log(`Backend rodando na porta ${process.env.PORT || 3001}`));
