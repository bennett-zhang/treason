/*
 * Copyright 2015 Christopher Brown
 *
 * This work is licensed under the Creative Commons Attribution-NonCommercial 4.0 International License.
 *
 * To view a copy of this license, visit http://creativecommons.org/licenses/by-nc/4.0/ or send a letter to:
 *     Creative Commons
 *     PO Box 1866
 *     Mountain View
 *     CA 94042
 *     USA
 */
var lodash = require('lodash');
var Minimax = require('./minimax');
var createGameCore = require('./game-core');
var shared = require('./web/shared');
var stateNames = shared.states;
var actions = shared.actions;

function createMinimaxPlayer(game, options) {
    var player = {
        name: 'Minimax',
        onStateChange: onStateChange,
        onHistoryEvent: onHistoryEvent,
        onChatMessage: function() {},
        type: 'minimax'
    };

    try {
        var gameProxy = game.playerJoined(player);
    }
    catch(e) {
        handleError(e);
        return;
    }

    var minimax = new Minimax({
        evaluate: evaluate,
        getPossibleMoves: getPossibleMoves,
        applyMove: applyMove
    });

    var gameCore = createGameCore({
        drawRole: function () {
            return 'unknown';
        }
    });

    var aiPlayerIdx;

    function onStateChange(state) {
        aiPlayerIdx = state.playerIdx;
        aiPlayer = state.players[aiPlayerIdx];
        currentPlayer = state.players[state.state.playerIdx];
        targetPlayer = state.players[state.state.target];

        if (state.state.name === stateNames.START_OF_TURN && currentPlayer === aiPlayer) {
            // Start of our turn.
        }
        else if (state.state.name === stateNames.ACTION_RESPONSE && aiPlayer !== currentPlayer) {
            // We can respond to an action:
            //   We may be targeted and be able to block or challenge.
            //   We may not be targeted and only be able to challenge.
        }
        else if (state.state.name === stateNames.FINAL_ACTION_RESPONSE && aiPlayer === targetPlayer) {
            // We have a final chance to block an action against us.
        }
        else if (state.state.name === stateNames.BLOCK_RESPONSE && aiPlayer !== targetPlayer) {
            // Our action or another player's action has been blocked and we have an opportunity to challenge.
        }
        else if (state.state.name === stateNames.REVEAL_INFLUENCE && state.state.playerToReveal === state.playerIdx) {
            // We need to reveal an influence.
        }
        else if (state.state.name === stateNames.EXCHANGE && currentPlayer === aiPlayer) {
            // We must choose which roles to exchange.
        }
        else {
            // We should not respond to this state.
            return;
        }

        minimax.getBestMove({
            livePlayers: getLivePlayers(state),
            currentPlayer: state.playerIdx, // In the minimax state it is always our 'turn', which might just mean our turn to block.
            state: state
        });
    }

    function onHistoryEvent() {
    }

    function evaluate(gameState, playerIdx) {
    }

    /**
     * This function is called for all the players to enumerate all the ways they could react to a given game state.
     * The index of the player who is reacting is given in gameState.currentPlayer.
     */
    function getPossibleMoves(gameState) {
        var state = gameState.state;
        if (state.state.name === stateNames.START_OF_TURN) {
            // Start of a player's turn.
            return getPossibleActionMoves(gameState);
        }
        else if (state.state.name === stateNames.ACTION_RESPONSE) {
            // A player can challenge, allow, or potentially block.
            return getPossibleBlockMoves(gameState).concat([{command: 'allow'}, {command: 'challenge'}]);
        }
        else if (state.state.name === stateNames.FINAL_ACTION_RESPONSE) {
            // A player has a final chance to block.
            return getPossibleBlockMoves(gameState);
        }
        else if (state.state.name === stateNames.BLOCK_RESPONSE) {
            // An action has been blocked and a player has an opportunity to challenge.
            return [{command: 'allow'}, {command: 'challenge'}];
        }
        else if (state.state.name === stateNames.REVEAL_INFLUENCE) {
            // A player must reveal an influence.
            return getPossibleRevealMoves(gameState);
        }
        else if (state.state.name === stateNames.EXCHANGE) {
            // A player must choose which roles to exchange.
            return getPossibleExchangeMoves(gameState);
        }
        else {
            // no possible moves!
            return [];
        }
    }

    function getPossibleActionMoves(gameState) {
        var state = gameState.state;
        var player = state.players[gameState.currentPlayer];
        var i;
        var moves = [];
        if (player.cash >= 7) {
            // Enumerate the player's possible coup targets.
            for (i = 0; i < state.players.length; i++) {
                if (i !== gameState.currentPlayer && countInfluences(state.players[i]) > 0) {
                    moves.push({
                        command: 'play-action',
                        action: 'coup',
                        target: i
                    });
                }
            }
        }
        if (player.cash >= 10) {
            // At $10+ the player can only coup.
            return moves;
        }
        if (player.cash >= 3) {
            // Enumerate the player's possible assassination targets.
            for (i = 0; i < state.players.length; i++) {
                if (i !== gameState.currentPlayer && countInfluences(state.players[i]) > 0) {
                    moves.push({
                            command: 'play-action',
                        action: 'assassinate',
                        target: i
                    });
                }
            }
        }
        // Enumerate the player's possible steal targets.
        for (i = 0; i < state.players.length; i++) {
            if (i !== gameState.currentPlayer && countInfluences(state.players[i]) > 0) {
                moves.push({
                    command: 'play-action',
                    action: 'steal',
                    target: i
                });
            }
        }
        moves.push({
            command: 'play-action',
            action: 'tax'
        });
        moves.push({
            command: 'play-action',
            action: 'exchange'
        });
        moves.push({
            command: 'play-action',
            action: 'income'
        });
        moves.push({
            command: 'play-action',
            action: 'foreign-aid'
        });
        return moves;
    }

    function getPossibleBlockMoves(gameState) {
        var state = gameState.state;
        var action = actions[state.state.action];
        if (!action.blockedBy) {
            // The action cannot be blocked.
            return [];
        }
        if (action.targeted && state.state.target !== gameState.currentPlayer) {
            // The current player is not targeted and so may not block;
            return [];
        }
        return action.blockedBy.map(function (role) {
            return {
                command: 'block',
                blockingRole: role
            };
        });
    }

    function getPossibleRevealMoves(gameState) {
        var influences = getInfluences(gameState.state.players[gameState.currentPlayer]);
        return lodash.uniq(influences).map(function (role) {
            return {
                command: 'reveal',
                role: role
            };
        });
    }

    function getPossibleExchangeMoves(gameState) {
        var count = countInfluences(gameState.state.players[gameState.currentPlayer]);
        var exchangeOptions = gameState.state.state.exchangeOptions;
        var rolesets;
        if (count === 1) {
            rolesets = exchangeOptions.map(function (role) {
                return [role];
            });
        }
        else if (count === 2) {
            rolesets = [];
            for (var i = 0; i < exchangeOptions.length; i++) {
                for (var j = 0; j < exchangeOptions.length; j++) {
                    if (i !== j) {
                        rolesets.push([exchangeOptions[i], exchangeOptions[j]]);
                    }
                }
            }
        }
        else {
            // Impossible.
            rolesets = [];
        }
        rolesets = lodash.uniqWith(rolesets, function (a, b) {
            return lodash.isEqual(a.sort(), b.sort());
        });
        return rolesets.map(function (roles) {
            return {
                command: 'exchange',
                roles: roles
            };
        });
    }

    function applyMove(gameState, move) {
        var oldStateName = gameState.state.state.name;
        var newState, newPlayer, i;

        if (move.command === 'challenge') {
            var challengedPlayer, challengedRole;
            if (gameState.state.state.name === stateNames.ACTION_RESPONSE || gameState.state.state.name === stateNames.FINAL_ACTION_RESPONSE) {
                challengedPlayer = gameState.state.state.playerIdx;
                challengedRole = actions[gameState.state.state.action].role;
            }
            else if (gameState.state.state.name === stateNames.BLOCK_RESPONSE) {
                challengedPlayer = gameState.state.state.target;
                challengedRole = gameState.state.state.blockingRole;
            }
            else {
                throw new Error('Illegal state');
            }

            // todo: optimize on the first turn if the AI knows the challenge outcome (no opponent choices further up the tree)

            // Set all the roles to 'unknown' - the challenge will be correct by default.
            var correctChallengePreState = lodash.cloneDeep(gameState.state);
            correctChallengePreState.players[challengedPlayer].influence.forEach(function (influence) {
                if (!influence.revealed) {
                    influence.role = 'unknown';
                }
            });

            // Grant the player the role to force the challenge to be incorrect.
            var incorrectChallengePreState = lodash.cloneDeep(gameState.state);
            incorrectChallengePreState.players[challengedPlayer].influence.forEach(function (influence) {
                if (!influence.revealed) {
                    influence.role = challengedRole;
                }
            });

            var correctChallengePostState = gameCore.applyCommand(correctChallengePreState, gameState.currentPlayer, move);
            var incorrectChallengePostState = gameCore.applyCommand(incorrectChallengePreState, gameState.currentPlayer, move);

            var correctChallengeLikelihood, incorrectChallengeLikelihood, correctChallengeLikelihoodAi, incorrectChallengeLikelihoodAi;

            var influences = getInfluences(gameState.state.players[challengedPlayer]);
            if (influences.length === 2) {
                // Simple probability of being dealt a given role.
                correctChallengeLikelihood = 0.36;
                incorrectChallengeLikelihood = 0.64;
            }
            else if (influences.length === 1) {
                // Simple probability of having any one of five possible roles.
                correctChallengeLikelihood = 0.2;
                incorrectChallengeLikelihood = 0.8;
            }
            else {
                throw new Error('Illegal state');
            }

            if (challengedPlayer === aiPlayerIdx) {
                var hasRole = influences.indexOf(challengedRole) > -1;
                if (hasRole) {
                    correctChallengeLikelihoodAi = 0;
                    incorrectChallengeLikelihoodAi = 1;
                }
                else {
                    correctChallengeLikelihoodAi = 1;
                    incorrectChallengeLikelihoodAi = 0;
                }
            }

            return [
                {
                    likelihood: correctChallengeLikelihood,
                    likelihoodAi: correctChallengeLikelihoodAi,
                    state: correctChallengePostState,
                    currentPlayer: whoseTurn(correctChallengePostState, oldStateName),
                    livePlayers: getLivePlayers(correctChallengePostState)
                },
                {
                    likelihood: incorrectChallengeLikelihood,
                    likelihoodAi: incorrectChallengeLikelihoodAi,
                    state: incorrectChallengePostState,
                    currentPlayer: whoseTurn(incorrectChallengePostState, oldStateName),
                    livePlayers: getLivePlayers(incorrectChallengePostState)
                }
            ];
        } else {
            newState = gameCore.applyCommand(gameState.state, gameState.currentPlayer, move);
            return {
                state: newState,
                currentPlayer: whoseTurn(newState, oldStateName),
                livePlayers: getLivePlayers(newState)
            };
        }
    }

    function whoseTurn(newState, oldStateName) {
        if (newState.state.name === stateNames.START_OF_TURN) {
            return newState.state.playerIdx;
        }
        else if (newState.state.name === stateNames.ACTION_RESPONSE ||
            newState.state.name === stateNames.BLOCK_RESPONSE) {

            if (newState.state.name !== oldStateName) {
                if (newState.state.name === stateNames.ACTION_RESPONSE &&
                    newState.state.target != null) {
                    // The target should play first because they are most likely to respond.
                    return newState.state.target;
                }
                else if (newState.state.name === stateNames.BLOCK_RESPONSE) {
                    // The player whose action is blocked should play first because they are most likely to respond.
                    return newState.state.playerIdx;
                }
            }
            // Pick the first player who can respond.
            for (i = 0; i < newState.state.allowed.length; i++) {
                if (!newState.state.allowed[i]) {
                    return i;
                }
            }
            throw new Error('Illegal state');
        }
        else if (newState.state.name === stateNames.FINAL_ACTION_RESPONSE) {
            // The target of the action is the only player who can play.
            return newState.state.target;
        }
        else if (newState.state.name === stateNames.GAME_WON) {
            // No one can play once the game is over.
            return null;
        }
        else if (newState.state.name === stateNames.EXCHANGE) {
            return newState.state.playerIdx;
        }
        else if (newState.state.name === stateNames.REVEAL_INFLUENCE) {
            return newState.state.playerToReveal;
        }
        else {
            throw new Error('Illegal state');
        }
    }

    function getLivePlayers(state) {
        var live = [];
        for (var i = 0; i < state.players.length; i++) {
            var player = state.players[i];
            var hasInfluence = countInfluences(player) > 0;
            live.push(hasInfluence);
        }
    }

    function countInfluences(player) {
        return getInfluences(player).length;
    }

    function getInfluences(player) {
        if (player.isObserver) {
            return [];
        }
        var roles = [];
        for (var i = 0; i < player.influence.length; i++) {
            if (!player.influence[i].revealed) {
                roles.push(player.influence[i].role);
            }
        }
        return roles;
    }

    return {
        _test: {
            getPossibleMoves: getPossibleMoves,
            applyMove: applyMove,
            setAiPlayerIdx: function (idx) {
                aiPlayerIdx = idx;
            }
        }
    };
}

module.exports = createMinimaxPlayer;
