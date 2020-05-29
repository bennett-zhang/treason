/*
 * Copyright 2015-2016 Christopher Brown and Jackie Niebling.
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
'use strict';

var extend = require('extend');
var randomGen = require('random-seed');
var fs = require('fs');
var lodash = require('lodash');
var md5 = require('md5');

var shared = require('./web/shared');
var stateNames = shared.states;
var actions = shared.actions;

var cleverbot = require('./cleverbot.js')
var validator = require('validator');

var rankedRoles = ['duke', 'assassin', 'captain', 'inquisitor', 'contessa', 'ambassador'];
// The weights show how likely a role is to be revealed by AI
// E.g. ambassador is 3 times more likely to be revealed than duke
var roleWeights = {'duke': 3, 'assassin': 4, 'captain': 5, 'inquisitor': 6, 'contessa': 6, 'ambassador': 9};

// https://www.randomlists.com/random-first-names
// http://listofrandomnames.com/
// http://random-name-generator.info/
var aiPlayerNames = fs.readFileSync(__dirname + '/names.txt', 'utf8').split(/\r?\n/);

function createAiPlayer(game, options) {
    options = extend({
        moveDelay: 0,           // How long the AI will "think" for before playing its move (ms)
        moveDelaySpread: 0,     // How much randomness to apply to moveDelay (ms)
        searchHorizon: 7,       // How many moves the AI will search ahead for an end-game
        chanceToBluff: 0.5,     // Fraction of games in which the AI will bluff
        chanceToChallenge: 0.1  // Fraction of turns in which the AI will challenge (not in the end-game)
    }, options);

    var rand = randomGen.create(options.randomSeed);

    var labelFriend = false;
    var chanceToHaveFriend = 1;
    var hasFriend = Math.random() <= chanceToHaveFriend;

    var chatHistory = [];
    var chatPartners = [];

    var player = {
        name: (labelFriend && hasFriend ? 'Friend ' : '') + aiPlayerNames[rand(aiPlayerNames.length)],
        onStateChange: onStateChange,
        onAllowsChange: () => {},
        onHistoryEvent: onHistoryEvent,
        onChatMessage: onChatMessage,
        onCode: () => {},
        ai: true,
        playerId: 'ai',
        friend: hasFriend ? 'Ben' : null
    };

    try {
        var gameProxy = game.playerJoined(player);
    } catch(e) {
        handleError(e);
        return;
    }

    var bluffChoice;
    var state;
    var aiPlayer;
    var currentPlayer;
    var targetPlayer;
    var lastInfluenceSeenIdx = -1;
    var influencesSeen = [];
    // Array indexed by playerIdx, containing objects whose keys are the roles each player (including us) has claimed
    var claims = [];
    // The last role to be claimed. Used when a challenge is issued, to track which role was challenged.
    var lastRoleClaim;
    var timeout = null;
    // Roles that we have bluffed and then been called on - can no longer bluff these.
    var calledBluffs = [];
    var needReset = true;

    function onStateChange(s) {
        state = s;
        if (timeout != null) {
            clearTimeout(timeout);
        }
        if (state.state.name === stateNames.WAITING_FOR_PLAYERS) {
            needReset = true;
        }
        else {
            // Reset when the game actually starts: the first state after WAITING_FOR_PLAYERS.
            if (needReset) {
                reset();
                needReset = false;
            }
            var delay = rand.intBetween(options.moveDelay - options.moveDelaySpread, options.moveDelay + options.moveDelaySpread);
            timeout = setTimeout(onStateChangeAsync, delay);
        }
    }

    function onStateChangeAsync() {
        timeout = null;
        aiPlayer = state.players[state.playerIdx];
        currentPlayer = state.players[state.state.playerIdx];
        targetPlayer = state.players[state.state.target];

        if (state.state.name == stateNames.ACTION_RESPONSE) {
            // If we respond to an action, we need to know who claimed what role
            lastRoleClaim = {
                role: getRoleForAction(state.state.action),
                playerIdx: state.state.playerIdx
            };
        } else if (state.state.name == stateNames.BLOCK_RESPONSE) {
            // If we respond to a block, we need to know who claimed the blocking role
            lastRoleClaim = {
                role: state.state.blockingRole,
                playerIdx: state.state.target
            };
        } else if (state.state.name != stateNames.REVEAL_INFLUENCE) {
            // Reset last claimed role for other states unless we're revealing our influence
            // In that case we need to remember last claimed role to update calledBluffs
            // This update is performed on history event which happens after state changes
            lastRoleClaim = null;
        }

        if (state.state.name == stateNames.START_OF_TURN && currentPlayer == aiPlayer) {
            playOurTurn();
        } else if (state.state.name == stateNames.ACTION_RESPONSE && aiPlayer != currentPlayer) {
            respondToAction();
        } else if (state.state.name == stateNames.FINAL_ACTION_RESPONSE && aiPlayer != currentPlayer) {
            respondToAction();
        } else if (state.state.name == stateNames.BLOCK_RESPONSE && aiPlayer != targetPlayer) {
            respondToBlock();
        } else if (state.state.name == stateNames.REVEAL_INFLUENCE && state.state.playerToReveal == state.playerIdx) {
            revealByProbability();
        } else if (state.state.name == stateNames.EXCHANGE && currentPlayer == aiPlayer) {
            exchange();
        }
    }

    function reset() {
        lastInfluenceSeenIdx = -1;
        influencesSeen = [];
        claims = [];
        calledBluffs = [];
        for (var i = 0; i < state.numPlayers; i++) {
            claims[i] = {};
            calledBluffs[i] = {};
        }

        lastRoleClaim = null;
        bluffChoice = rand.random() < options.chanceToBluff;
    }

    function getRoleForAction(actionName) {
        var action = actions[actionName];
        if (!action) {
            return null;
        }
        if (!action.roles) {
            return null;
        }
        return lodash.intersection(state.roles, lodash.flatten([action.roles]))[0];
    }

    function onHistoryEvent(message, type, histGroup) {
        var match = message.match(/\{([0-9]+)\} revealed ([a-z]+)/);
        if (match) {
            var playerIdx = match[1];
            var role = match[2];
            // If the player had previously claimed the role, this claim is no longer valid
            if (claims[playerIdx]) {
                delete claims[playerIdx][role];
            }
        }
        if (message.indexOf(' challenged') > 0 && lastRoleClaim && claims[lastRoleClaim.playerIdx]) {
            // If a player was successfully challenged, any earlier claim was a bluff.
            // If a player was incorrectly challenged, they swap the role, so an earlier claim is no longer valid.
            delete claims[lastRoleClaim.playerIdx][lastRoleClaim.role];
        }
        if (message.indexOf(' successfully challenged') > 0 && lastRoleClaim && calledBluffs[lastRoleClaim.playerIdx]) {
            // If a player was successfully challenged, remember it to prevent him from claiming that role again
            calledBluffs[lastRoleClaim.playerIdx][lastRoleClaim.role] = true;
        }
        if (type === 'interrogate' && aiPlayer.friend && state.playerIdx === state.state.target) {
            var seenMatch = message.match(/\{([0-9]+)\} saw your ([a-z]+)/);
            if (seenMatch) {
                for (var i = 0; i < aiPlayer.influence.length; i++) {
                    var influence = aiPlayer.influence[i];
                    if (!influence.revealed && influence.role === seenMatch[2]) {
                        lastInfluenceSeenIdx = i;
                        break;
                    }
                }
            } else if (message.indexOf('exchange') > 0) {
                lastInfluenceSeenIdx = -1;
            } else if (lastInfluenceSeenIdx >= 0) {
                influencesSeen[lastInfluenceSeenIdx] = true;
            }
        }
    }

    function onChatMessage(playerIdx, message) {
        if (!state.players[playerIdx].ai) {
            var messageMatch = message.match(/(.+?),(.+)/);

            if (messageMatch) {
                chatPartners[playerIdx] = messageMatch[1].trim().toLowerCase() ===
                                          state.players[state.playerIdx].name.toLowerCase();

                message = messageMatch[2];
            }

            if (chatPartners[playerIdx]) {
                cleverbot(validator.unescape(message), chatHistory).then(res => {
                    gameProxy.sendChatMessage(res);
                    chatHistory.push(validator.unescape(message));
                    chatHistory.push(res);
                });
            }
        }
    }

    function isTeammate(playerIdx) {
        if (playerIdx == state.playerIdx) {
            // For the purpose here, we are not our own teammate.
            return false;
        }
        return !state.freeForAll && aiPlayer.team == state.players[playerIdx].team;
    }

    function enemyCount() {
        var count = 0;

        for (var i = 0; i < state.numPlayers; i++) {
            var player = state.players[i];

            if (player.influenceCount > 0) {
                if (!aiPlayer.friend)
                    count++;
                else if (player.name !== aiPlayer.friend && player.friend !== aiPlayer.friend)
                    count++;
            }
        }

        return count;
    }

    function shouldTarget(playerIdx) {
        var player = state.players[playerIdx];

        if (!player || player.influenceCount <= 0 || isTeammate(playerIdx))
            return false;

        if (!aiPlayer.friend)
            return true;
        
        if (player.name === aiPlayer.friend || (enemyCount() > 0 && player.friend === aiPlayer.friend))
            return false;

        return true;
    }

    function respondToAction() {
        if (aiPlayer.influenceCount <= 0)
            return;

        if (!shouldTarget(state.state.playerIdx)) {
            debug('allowing');
            command({
                command: 'allow'
            });
            return;
        }

        trackClaim(state.state.playerIdx, state.state.action);
        if (isTeammate(state.state.playerIdx)) {
            // Allow our teammate's actions.
            debug('allowing');
            command({
                command: 'allow'
            });
            return;
        }
        if (state.state.action === 'steal' && aiPlayer.cash === 0) {
            // If someone wants to steal nothing from us, go ahead.
            debug('allowing');
            command({
                command: 'allow'
            });
            return;
        }

        var blockedBy = actions[state.state.action].blockedBy;
        if (blockedBy) {
            for (var role of blockedBy) {
                if (takeRole(role))
                    break;
            }
        }

        var blockingRole = getBlockingRole();
        if (blockingRole) {
            debug('blocking');
            trackClaim(state.playerIdx, blockingRole);
            command({
                command: 'block',
                blockingRole: blockingRole
            });
            return;
        }

        // Don't bluff in the final action response - it will just get challenged.
        if (state.state.name == stateNames.ACTION_RESPONSE) {
            if (shouldChallenge() && (!aiPlayer.friend || isLying())) {
                debug('challenging');
                command({
                    command: 'challenge'
                });
                return;
            }

            if (state.state.action === 'interrogate' && aiPlayer.friend && state.playerIdx === state.state.target) {
                for (var i = 0; i < aiPlayer.influenceCount; i++) {
                    takeRole('inquisitor');
                }
            }

            blockingRole = getBluffedBlockingRole();
            if (blockingRole) {
                debug('blocking (bluff)');
                trackClaim(state.playerIdx, blockingRole);
                command({
                    command: 'block',
                    blockingRole: blockingRole
                });
                return;
            }
        }

        debug('allowing');
        command({
            command: 'allow'
        });
    }

    function respondToBlock() {
        if (aiPlayer.influenceCount <= 0)
            return;

        if (!shouldTarget(state.state.target)) {
            debug('allowing');
            command({
                command: 'allow'
            });
            return;
        }

        trackClaim(state.state.target, state.state.blockingRole);
        if (isTeammate(state.state.target)) {
            // Allow our teammate's actions.
            debug('allowing');
            command({
                command: 'allow'
            });
            return;
        }
        if (shouldChallenge() && (!aiPlayer.friend || isLying())) {
            debug('challenging');
            command({
                command: 'challenge'
            });
        } else {
            debug('allowing');
            command({
                command: 'allow'
            });
        }
    }

    function isLying() {
        if (state.state.name === stateNames.ACTION_RESPONSE) {
            if (state.state.action === 'embezzle')
                return game._test_hasRole(state.state.playerIdx, 'duke');

            return !game._test_hasRole(state.state.playerIdx, getRoleForAction(state.state.action));
        }
        else if (state.state.name === stateNames.BLOCK_RESPONSE) {
            return !game._test_hasRole(state.state.target, state.state.blockingRole);
        }
    }

    function shouldChallenge() {
        // We're challenging only actions and blocks
        if (state.state.name != stateNames.ACTION_RESPONSE && state.state.name != stateNames.BLOCK_RESPONSE) {
            return false;
        }

        // Challenge if somebody claims to have role that was revealed 3 times or we have the rest of them
        var claimedRole = state.state.name == stateNames.ACTION_RESPONSE ? getRoleForAction(state.state.action) : state.state.blockingRole;
        var usedRoles = countRevealedRoles(claimedRole);
        for (var i = 0; i < aiPlayer.influence.length; i++) {
            if (!aiPlayer.influence[i].revealed && aiPlayer.influence[i].role === claimedRole) {
                usedRoles++;
            }
        }
        if (usedRoles === state.numRoles) {
            return true;
        }

        // Challenge if somebody claimed this role and lost
        if (state.state.name == stateNames.ACTION_RESPONSE && calledBluffs[state.state.playerIdx] && calledBluffs[state.state.playerIdx][claimedRole]) {
            // If someone claims an action again after being successfully challenged
            return true;
        }
        if (state.state.name == stateNames.BLOCK_RESPONSE && calledBluffs[state.state.target] && calledBluffs[state.state.target][claimedRole]) {
            // If someone claims a blocking action again after being successfully challenged
            return true;
        }

        if (state.state.name == stateNames.ACTION_RESPONSE && state.state.action === 'assassinate'
            && state.players[state.playerIdx].influenceCount === 1) {
            // Challenge if you're being assassinated, it's your last influence and all contessas have been revealed
            var contessas = countRevealedRoles('contessa');
            if (contessas === state.numRoles) {
                return true;
            }
            // If all contessas have been revealed or claimed then we challenge the assassin
            for (var i = 0; i < state.numPlayers; i++) {
                if (i != state.playerIdx && state.players[i].influenceCount > 0 && claims[i]['contessa']) {
                    contessas++;
                }
            }
            if (contessas >= state.numRoles) {
                return true;
            }
            // Challenge if we already bluffed contessa and were caught
            if (calledBluffs[state.playerIdx] && calledBluffs[state.playerIdx]['contessa']) {
                return true;
            }
            // Otherwise we will bluff contessa
            return false;
        }

        if (state.state.name == stateNames.ACTION_RESPONSE && state.state.action === 'embezzle') {
            if (countRevealedRoles('duke') === state.numRoles) {
                return false;
            }
        }

        // Only challenge actions that could lead to a victory if not challenged.
        if (!actionIsWorthChallenging()) {
            return false;
        }

        if (isEndGame()) {
            var result = simulate();
            // Challenge if the opponent would otherwise win soon.
            if (result < 0) {
                return true;
            }
            // Don't bother challenging if we're going to win anyway.
            if (result > 0) {
                return false;
            }
        }

        // Challenge at random.
        return rand.random() < options.chanceToChallenge;
    }

    function actionIsWorthChallenging() {
        // Worth challenging anyone drawing tax.
        if (state.state.action == 'tax') {
            return true;
        }
        // Worth challenging someone assassinating us or stealing from us,
        // Or someone trying to block us from assassinating or stealing.
        if ((state.state.action == 'steal' || state.state.action == 'assassinate') &&
            (state.state.playerIdx == state.playerIdx || state.state.target == state.playerIdx)) {
            return true;
        }
        return false;
    }

    function countRevealedRoles(role) {
        var count = 0;
        for (var i = 0; i < state.numPlayers; i++) {
            for (var j = 0; j < state.players[i].influence.length; j++) {
                if (state.players[i].influence[j].revealed && state.players[i].influence[j].role === role) {
                    count++;
                }
            }
        }
        return count;
    }

    function isEndGame() {
        var opponents = playersByStrength();
        return opponents.length == 1;
    }

    // This function adds randomness to AI decision making process
    // Even if some decision seem a good idea, sometimes AI will make a different call
    // Otherwise AIs are predictable and human opponents can predict their moves
    function randomizeChoice() {
        // At the end AIs won't make random choices as it might make them lose
        if (isEndGame() && state.players[state.playerIdx].influenceCount === 1) {
            return false;
        }
        return rand.intBetween(0, 9) < 1;
    }

    function getBlockingRole() {
        var influence = ourInfluence();
        if (state.state.action == 'foreign-aid' || state.state.target == state.playerIdx) {
            var blockingRoles = actions[state.state.action].blockedBy || [];
            for (var i = 0; i < blockingRoles.length; i++) {
                if (influence.indexOf(blockingRoles[i]) >= 0) {
                    return blockingRoles[i];
                }
            }
        }
        return null;
    }

    function getBluffedBlockingRole() {
        if (state.state.action != 'foreign-aid' && state.state.target != state.playerIdx) {
            // Don't bluff unless this is an action we can block.
            return null;
        }
        var blockingRoles = actions[state.state.action].blockedBy || [];
        blockingRoles = lodash.intersection(state.roles, blockingRoles);
        if (blockingRoles.length == 0) {
            // Cannot be blocked.
            return null;
        }
        blockingRoles = shuffle(blockingRoles.slice());

        var choice = null;
        for (var i = 0; i < blockingRoles.length; i++) {
            if (shouldBluff(blockingRoles[i])) {
                // Now that we've bluffed, recalculate whether or not to bluff next time.
                bluffChoice = rand.random() < options.chanceToBluff;
                return blockingRoles[i];
            }
        }
        // No bluffs are appropriate.
        return null;
    }

    function shuffle(array) {
        var shuffled = [];
        while (array.length) {
            var i = Math.floor(Math.random() * array.length);
            var e = array.splice(i, 1);
            shuffled.push(e[0]);
        }
        return shuffled;
    }

    function trackClaim(playerIdx, actionOrRole) {
        // if action is characterless (income, foreign aid or coup) don't update claims
        if (actions[actionOrRole] && !actions[actionOrRole].roles) {
            return;
        }
        var role = getRoleForAction(actionOrRole) || actionOrRole;
        claims[playerIdx][role] = true;
        debug('player ' + playerIdx + ' claimed ' + role);
    }

    function isReformation() {
        return state.gameType == 'reformation';
    }

    function playOurTurn() {
        var influence = ourInfluence();
        debug('influence: ' + influence);

        var command = bestCoupOrTeamChange();
        var aliveCount = playersAliveCount();
        var strongestPlyrIdx = strongestPlayer();
        var assassinTgt = assassinTarget();
        var captainTgt = captainTarget();

        if (state.treasuryReserve > 1)
            discardRole('duke');
        else
            takeRole('duke');

        if (assassinTgt)
            takeRole('assassin');
        else if (captainTgt)
            takeRole('captain');

        influence = ourInfluence();

        if (aiPlayer.cash >= 10) {
            // Have to coup
            playAction('coup', strongestPlyrIdx);
        } else if (command.action !== 'do-nothing') {
            // Coup or change someone's team in order to protect the most friends
            playAction(command.action, command.target);
        } else if (isReformation() && aiPlayer.cash >= 1 && !aiPlayer.friend && onTeamByThemselves(state.playerIdx)
                && aliveCount > 2) {
            
            // Don't want to be on a team by yourself
            playAction('change-team');
        } else if (aiPlayer.cash >= 7 && !command.force && (shouldTarget(strongestPlyrIdx) || aliveCount === 2)) {
            if (state.players[strongestPlyrIdx].name === aiPlayer.friend) {
                playAction('assassinate', strongestPlyrIdx);
            } else {
                playAction('coup', strongestPlyrIdx);
            }
        } else if (influence.indexOf('assassin') >= 0 && aiPlayer.cash >= 3 && !command.force && assassinTgt != null && !randomizeChoice()) {
            playAction('assassinate', assassinTgt);
        } else if (influence.indexOf('captain') >= 0 && state.treasuryReserve < 3 && captainTgt != null && !randomizeChoice()) {
            playAction('steal', captainTgt);
        } else if (influence.indexOf('duke') >= 0 && state.treasuryReserve < 4 && !randomizeChoice()) {
            playAction('tax');
        } else if (isReformation() && influence.indexOf('duke') == -1 && influence.indexOf('captain') > -1 && state.treasuryReserve > 2 && !randomizeChoice()) {
            playAction('embezzle');
        } else if (isReformation() && influence.indexOf('duke') == -1 && influence.indexOf('captain') == -1 && state.treasuryReserve > 1 && !randomizeChoice()) {
            playAction('embezzle');
        } else if (countRevealedRoles('duke') == state.numRoles && influence.indexOf('captain') == -1 && !randomizeChoice()) {
            playAction('foreign-aid');
        } else {
            // No good moves - check whether to bluff.
            var possibleBluffs = [];
            if (aiPlayer.friend) {
                if (aiPlayer.cash >= 3 && assassinTgt != null && takeRole('assassin')) {
                    possibleBluffs.push('assassinate');
                }
                if (captainTgt != null && takeRole('captain')) {
                    possibleBluffs.push('steal');
                }
                if (takeRole('duke')) {
                    possibleBluffs.push('tax');
                }
                if (isReformation() && state.treasuryReserve > 3) {
                    possibleBluffs.push('embezzle');
                }
            } else {
                if (aiPlayer.cash >= 3 && assassinTgt != null && shouldBluff('assassinate')) {
                    possibleBluffs.push('assassinate');
                }
                if (captainTgt != null && shouldBluff('steal')) {
                    possibleBluffs.push('steal');
                }
                if (shouldBluff('tax')) {
                    possibleBluffs.push('tax');
                }
                if (isReformation() && shouldBluff('embezzle')) {
                    possibleBluffs.push('embezzle');
                }
            }
            if (possibleBluffs.length && !randomizeChoice()) {
                // Randomly select one.
                var actionName = possibleBluffs[rand(possibleBluffs.length)];
                if (actionName == 'tax') {
                    takeRole('duke');
                    playAction('tax');
                } else if (actionName == 'steal') {
                    takeRole('captain');
                    playAction('steal', captainTgt);
                } else if (actionName == 'assassinate') {
                    takeRole('assassin');
                    playAction('assassinate', assassinTgt);
                } else if (isReformation() && actionName == 'embezzle') {
                    discardRole('duke');
                    playAction('embezzle');
                }
                // Now that we've bluffed, recalculate whether or not to bluff next time.
                bluffChoice = rand.random() < options.chanceToBluff;
            } else {
                // No bluffing.
                if (influence.indexOf('assassin') < 0 && !randomizeChoice()) {
                    if (state.gameType === 'inquisitors' || state.gameType == 'reformation')
                        takeRole('inquisitor');
                    else
                        takeRole('ambassador');

                    // If we don't have a captain, duke, or assassin, then exchange.
                    playAction('exchange');
                } else {
                    // We have an assassin, but can't afford to assassinate.
                    if (countRevealedRoles('duke') == state.numRoles) {
                        playAction('foreign-aid');
                    } else {
                        playAction('income');
                    }
                }
            }
        }
    }

    function takeRole(role) {
        if (!aiPlayer.friend || (calledBluffs[state.playerIdx] && calledBluffs[state.playerIdx][role]))
            return aiPlayer.influence.some(inf => !inf.revealed && inf.role === role);
        
        var influenceRoles = [];
        var replaced = false;
        for (var i = 0; i < aiPlayer.influence.length; i++) {
            var inf = aiPlayer.influence[i];
            if (!inf.revealed) {
                if (!influencesSeen[i] && inf.role !== role && !replaced) {
                    influenceRoles.push(role);
                    replaced = true;
                }
                else {
                    influenceRoles.push(inf.role);
                }
            }
        }

        if (replaced) {
            var newInfluence = game._test_changeInfluence(state.playerIdx, influenceRoles);
            if (newInfluence) {
                aiPlayer.influence = newInfluence;
                return true;
            }
        }

        return aiPlayer.influence.some(inf => !inf.revealed && inf.role === role);
    }

    function discardRole(role) {
        if (!aiPlayer.friend)
            return !aiPlayer.influence.some(inf => !inf.revealed && inf.role === role);
        
        for (var i = 0; i < aiPlayer.influence.length; i++) {
            var inf = aiPlayer.influence[i];
            if (!inf.revealed && inf.role === role && influencesSeen[i])
                return false;
        }

        aiPlayer.influence = game._test_discardRole(state.playerIdx, role);
        return !aiPlayer.influence.some(inf => !inf.revealed && inf.role === role);
    }

    function shouldBluff(actionNameOrRole) {
        var influence = ourInfluence();
        var role;
        if (actions[actionNameOrRole]) {
            role = actions[actionNameOrRole].role;
        } else {
            role = actionNameOrRole;
        }
        if (actionNameOrRole === 'embezzle' && state.treasuryReserve == 0) {
            return false;
        } 
        if (actionNameOrRole === 'embezzle' && influence.indexOf('duke') >= 0 && state.treasuryReserve > 3) {
            return true;
        }
        if (calledBluffs[state.playerIdx] && calledBluffs[state.playerIdx][role]) {
            // Don't bluff a role that we previously bluffed and got caught out on.
            return false;
        }
        if (countRevealedRoles(role) == state.numRoles) {
            // Don't bluff a role that has already been revealed three times.
            return false;
        }
        if (actionNameOrRole === 'contessa' && state.state.action === 'assassinate' && state.players[state.playerIdx].influenceCount === 1) {
            // Bluff contessa if only 1 influence left as otherwise we lose
            return true;
        }
        if (!bluffChoice && !claims[state.playerIdx][role]) {
            // We shall not bluff (unless we already claimed this role earlier).
            return false;
        }
        if (Object.keys(claims[state.playerIdx]).length > 2 && !claims[state.playerIdx][role]) {
            // We have already bluffed a different role: don't bluff any more.
            return false;
        }
        // For now we can only simulate against a single opponent.
        if (isEndGame() && simulate(role) > 0) {
            // If bluffing would win us the game, we will probably be challenged, so don't bluff.
            return false;
        } else {
            // We will bluff.
            return true;
        }
    }

    function playAction(action, target) {
        debug('playing ' + action);
        trackClaim(state.playerIdx, action);
        command({
            command: 'play-action',
            action: action,
            target: target
        });
    }

    function command(command) {
        command.stateId = state.stateId;

        try {
            gameProxy.command(command);
        } catch(e) {
            console.error(e);
            console.error(e.stack);
        }
    }

    function ourInfluence() {
        var influence = [];
        for (var i = 0; i < aiPlayer.influence.length; i++) {
            if (!aiPlayer.influence[i].revealed) {
                influence.push(aiPlayer.influence[i].role);
            }
        }
        return influence;
    }

    function getClaimedRoles(playerIdx) {
        var roles = [];
        for (var k in claims[playerIdx]) {
            if (claims[playerIdx][k]) {
                roles.push(k);
            }
        }
        return roles;
    }

    function revealByProbability() {
        var influence = ourInfluence();
        var chosenInfluence = 0;

        if (influence.length > 1) {
            var influenceProbability = [];
            for (var i = 0; i < influence.length; i++) {
                for (var j = 0; j < roleWeights[influence[i]]; j++) {
                    influenceProbability.push(i);
                }
            }
            chosenInfluence = influenceProbability[rand.intBetween(0, influenceProbability.length-1)];
        }
        command({
            command: 'reveal',
            role: influence[chosenInfluence]
        });
        // Don't claim this role any more.
        if (claims[state.playerIdx]) {
            delete claims[state.playerIdx][influence[chosenInfluence]];
        }
    }

    function assassinTarget() {
        return playersByStrength().find(idx => {
            return !canBlock(idx, 'assassinate') && shouldTarget(idx);
        });
    }

    function captainTarget() {
        return playersByStrength().find(idx => {
            return !canBlock(idx, 'steal') && state.players[idx].cash > 0 && shouldTarget(idx);
        });
    }

    function canBlock(playerIdx, actionName) {
        return lodash.intersection(actions[actionName].blockedBy, getClaimedRoles(playerIdx)).length > 0;
    }

    function strongestPlayer() {
        var sortedPlayers = playersByStrength();

        if (sortedPlayers.length === 1 || !aiPlayer.friend)
            return sortedPlayers[0];

        var potentialTargets = sortedPlayers.filter(idx => state.players[idx].name !== aiPlayer.friend);
        var target = potentialTargets.find(idx => state.players[idx].friend !== aiPlayer.friend);

        if (target)
            return target;

        return potentialTargets[0];
    }

    // Rank opponents by influence first, and money second
    function playersByStrength() {
        // Start with live opponents who are not ourselves and who are not on our team
        var indices = [];

        for (var i = 0; i < state.numPlayers; i++) {
            if (i != state.playerIdx && state.players[i].influenceCount > 0 &&
                (state.freeForAll || aiPlayer.team != state.players[i].team)) {
                indices.push(i);
            }
        }

        debug('Indices without teammates: ' + indices.join());

        var randomNumber = rand(1000000000000000);

        return indices.sort(function (a, b) {
            var infa = state.players[a].influenceCount;
            var infb = state.players[b].influenceCount;

            if (infa != infb) {
                return infb - infa;
            } else if (state.players[b].cash != state.players[a].cash) {
                return state.players[b].cash - state.players[a].cash;
            } else { // if both players have the same amount of influences and cash then choose one by random
                // player names are used so that MD5 hashes are different for each player
                return md5(randomNumber + state.players[a].name) < md5(randomNumber + state.players[b].name) ? -1 : 1;
            }
        });
        return indices;
    }

    function friendPlayer() {
        return state.players.findIndex(player => {
            return player.name === aiPlayer.friend && player.influenceCount > 0
        });
    }

    function getThreatCount(friendPlyr) {
        var threatCount = {
            toFriend: 0,
            toFriendAIs: 0,
            toEnemies: 0
        };

        var numThreatsToRedTeam = state.players.filter((player, idx) => {
            return isThreat(idx, 1) && player.cash >= 7;
        }).length;
        var numThreatsToBlueTeam = state.players.filter((player, idx) => {
            return isThreat(idx, -1) && player.cash >= 7;
        }).length;

        if (friendPlyr) {
            if (friendPlyr.team === 1)
                threatCount.toFriend = numThreatsToRedTeam;
            else
                threatCount.toFriend = numThreatsToBlueTeam;
        }

        for (var player of state.players) {
            if (player.influenceCount > 0 && (!friendPlyr || player.name !== friendPlyr.name)) {
                if (player.friend === aiPlayer.friend) {
                    if (player.team === 1)
                        threatCount.toFriendAIs += numThreatsToRedTeam;
                    else
                        threatCount.toFriendAIs += numThreatsToBlueTeam;
                } else {
                    if (player.team === 1)
                        threatCount.toEnemies += numThreatsToRedTeam;
                    else
                        threatCount.toEnemies += numThreatsToBlueTeam;

                    // Non-friend AIs are not a threat to themselves
                    if (state.freeForAll && player.cash >= 7)
                        threatCount.toEnemies--;
                }
            }
        }

        return threatCount;
    }

    function bestCoupOrTeamChange() {
        if (!isReformation() || !aiPlayer.friend)
            return {action: 'do-nothing'};
       
        var friendPlyrIdx = friendPlayer();
        var friendPlyr = friendPlyrIdx < 0 ? null : state.players[friendPlyrIdx];
        var doNothingThreatCount = getThreatCount(friendPlyr);
        var coupThreatCounts = [];
        var teamChangeThreatCounts = [];

        // Count how many threats there will be after couping a player
        for (var i = 0; i < state.numPlayers; i++) {
            var player = state.players[i];
            var tempFreeForAll = state.freeForAll;
            var shouldTgt = shouldTarget(i);

            if (!shouldTgt || aiPlayer.cash < 7) {
                coupThreatCounts[i] = null;
                continue;
            }

            if (onTeamByThemselves(i) && player.influenceCount === 1)
                state.freeForAll = true;
            
            player.influenceCount--;
            coupThreatCounts[i] = getThreatCount(friendPlyr);
            player.influenceCount++;
            state.freeForAll = tempFreeForAll;
        }
        
        // Count how many threats there will be after changing teams
        // or converting a player
        for (var i = 0; i < state.numPlayers; i++) {
            var player = state.players[i];
            var tempFreeForAll = state.freeForAll;

            if (player.influenceCount === 0
                || (aiPlayer.cash < 2 && (aiPlayer.cash < 1 || i !== state.playerIdx))) {
                
                teamChangeThreatCounts[i] = null;
                continue;
            }

            if (onTeamByThemselves(i) || state.freeForAll)
                state.freeForAll = !state.freeForAll;

            player.team *= -1;
            teamChangeThreatCounts[i] = getThreatCount(friendPlyr);
            player.team *= -1;
            state.freeForAll = tempFreeForAll;
        }

        var threatCounts = [doNothingThreatCount, ...coupThreatCounts, ...teamChangeThreatCounts];

        // Minimize threats to friend
        var threatCount = arrayKeepExtremeValues(threatCounts, (a, b) => a.toFriend - b.toFriend, false);
        if (threatCount.toFriend > 0) {
            arrayKeepExtremeValues(threatCounts, (a, b) => {
                return (a.toEnemies / a.toFriend) - (b.toEnemies / b.toFriend)
            }, true);
            arrayKeepExtremeValues(threatCounts, (a, b) => {
                return (a.toFriendAIs / a.toFriend) - (b.toFriendAIs / b.toFriend)
            }, true);
        }

        // Minimize threats to friend AIs
        threatCount = arrayKeepExtremeValues(threatCounts, (a, b) => a.toFriendAIs - b.toFriendAIs, false);
        if (threatCount.toFriendAIs > 0) {
            arrayKeepExtremeValues(threatCounts, (a, b) => {
                return (a.toEnemies / a.toFriendAIs) - (b.toEnemies / b.toFriendAIs)
            }, true);
        }

        doNothingThreatCount = threatCounts[0];
        coupThreatCounts = threatCounts.slice(1, state.numPlayers + 1);
        teamChangeThreatCounts = threatCounts.slice(state.numPlayers + 1, state.numPlayers * 2 + 1);

        // If doing nothing is the best option
        if (!coupThreatCounts.find(el => el !== null) && !teamChangeThreatCounts.find(el => el !== null))
            return {action: 'do-nothing', force: true};

        // If couping is the best option, prioritize players going first
        if (!doNothingThreatCount) {
            for (var i = 1; i < state.numPlayers; i++) {
                var j = (state.playerIdx + i) % state.numPlayers;

                if (coupThreatCounts[j])
                    return {action: 'coup', target: j};
            }
        }

        // Change sides to be on the stronger team
        var strongTeam = strongerTeam();
        if (teamChangeThreatCounts[state.playerIdx] && strongTeam && aiPlayer.team !== strongTeam && playersAliveCount() > 2)
            return {action: 'change-team'};
        
        // Prioritize doing nothing, since it is free
        if (doNothingThreatCount)
            return {action: 'do-nothing'};
        
        // Change teams
        if (teamChangeThreatCounts[state.playerIdx])
            return {action: 'change-team'};
        
        // Convert players with zero coins,
        // since they can't change their team even if they wanted to.
        // Players with the most influences and who are going first
        // are prioritized.
        var targetIdx = -1;
        var maxInfluenceCount = 0;
        for (var i = 1; i < state.numPlayers; i++) {
            var j = (state.playerIdx + i) % state.numPlayers;

            if (teamChangeThreatCounts[j] && state.players[j].cash === 0 && state.players[j].influenceCount > maxInfluenceCount) {
                targetIdx = j;
                maxInfluenceCount = state.players[j].influenceCount;
            }
        }
        if (targetIdx >= 0)
            return {action: 'convert', target: targetIdx};

        // Prioritize converting players going last, since
        // they will be forced to stay on that team for the longest.
        for (var i = 1; i < state.numPlayers; i++) {
            var j = (state.playerIdx - i + state.numPlayers) % state.numPlayers;
            
            if (teamChangeThreatCounts[j])
                return {action: 'convert', target: j};
        }

        return {action: 'do-nothing'};
    }

    // Find the max or min value in an array, and replace all of the
    // non-extreme values in that array with null
    function arrayKeepExtremeValues(arr, compareFunc, max = true) {
        if (!arr.length)
            return arr;

        var extremeValue = arr.reduce((prev, curr) => {
            if (prev === null)
                return curr;

            if (curr === null)
                return prev;

            var compareValue = compareFunc(prev, curr);

            if ((max && compareValue > 0) || (!max && compareValue < 0))
                return prev;
            
            return curr;
        });

        for (var i = 0; i < arr.length; i++) {
            if (arr[i] !== null && compareFunc(arr[i], extremeValue) !== 0)
                arr[i] = null;
        }

        return extremeValue;
    }

    function playersAliveCount() {
        return state.players.reduce((prev, curr) => curr.influenceCount > 0 ? prev + 1 : prev, 0);
    }

    function isThreat(playerIdx, team) {
        var player = state.players[playerIdx];
        return player.name !== aiPlayer.friend && player.friend !== aiPlayer.friend
                && player.influenceCount > 0
                && (state.freeForAll || player.team !== team);
    }

    function onTeamByThemselves(playerIdx) {
        if (!isReformation())
            return;

        var team = state.players[playerIdx].team;

        for (var i = 0; i < state.numPlayers; i++) {
            if (i !== playerIdx && state.players[i].influenceCount > 0 && state.players[i].team === team)
                return false;
        }

        return true;
    }

    function strongerTeam() {
        var teamRed = {
            influenceCount: 0,
            cash: 0
        };

        var teamBlue = {
            influenceCount: 0,
            cash: 0
        };

        for (var i = 0; i < state.numPlayers; i++) {
            if (state.players[i].influenceCount > 0) {
                var team;

                if (state.players[i].team === 1)
                    team = teamRed;    
                else
                    team = teamBlue;

                team.influenceCount += state.players[i].influenceCount;
                team.cash += state.players[i].cash;
            }
        }

        if (teamRed.influenceCount > teamBlue.influenceCount)
            return 1;
        
        if (teamRed.influenceCount < teamBlue.influenceCount)
            return -1;

        if (teamRed.cash > teamBlue.cash)
            return 1;

        if (teamRed.cash < teamBlue.cash)
            return -1;
        
        return 0;
    }

    function exchange() {
        var chosen = [];
        var needed = ourInfluence().length;
        var available = state.state.exchangeOptions;

        for (var j = 0; j < needed; j++) {
            for (var i = 0; i < rankedRoles.length; i++) {
                var candidate = rankedRoles[i];
                if (chosen.indexOf(candidate) >= 0) {
                    // We already have this one
                    continue;
                }
                if (available.indexOf(candidate) >= 0) {
                    chosen.push(candidate);
                    break;
                }
            }
        }
        while (chosen.length < needed) {
            chosen.push(available[0]);
        }
        debug('chose ' + chosen);
        command({
            command: 'exchange',
            roles: chosen
        });
        // After exchanging our roles we can claim anything.
        claims[state.playerIdx] = {};
        calledBluffs[state.playerIdx] = {};
        influencesSeen = [];
    }

    // Simulates us and the remaining player playing their best moves to see who would win.
    // If we win, return 1; if the opponent wins, -1; if no one wins within the search horizon, 0.
    // Limitation: if a player loses an influence, it acts as if the player can still play either role.
    // Limitation: doesn't take foreign aid.
    function simulate(bluffedRole) {
        var opponentIdx = strongestPlayer();
        var cash = [
            state.players[opponentIdx].cash,
            state.players[state.playerIdx].cash
        ];
        var influenceCount = [
            state.players[opponentIdx].influenceCount,
            state.players[state.playerIdx].influenceCount
        ];
        var roles = [
            getClaimedRoles(opponentIdx),
            ourInfluence().concat([bluffedRole])
        ];
        debug('simulating with ' + roles[0] + ' and ' + roles[1]);
        debug('their cash: ' + cash[0]);
        debug('our cash: ' + cash[1]);
        var i, turn, other;
        function otherCanBlock(actionName) {
            return lodash.intersection(roles[other], actions[actionName].blockedBy).length > 0;
        }
        function canSteal() {
            return roles[turn].indexOf('captain') >= 0 && !otherCanBlock('steal');
        }
        function steal() {
            debug(turn ? 'we steal' : 'they steal');
            if (cash[other] < 2) {
                cash[turn] += cash[other];
                cash[other] = 0;
            } else {
                cash[turn] += 2;
                cash[other] -= 2;
            }
        }
        function canAssassinate() {
            return roles[turn].indexOf('assassin') >= 0 && !otherCanBlock('assassinate');
        }
        function assassinate() {
            debug(turn ? 'we assassinate' : 'they assassinate');
            cash[turn] -= 3;
            influenceCount[other] -= 1;
        }
        function canTax() {
            return roles[turn].indexOf('duke') >= 0;
        }
        function tax() {
            debug(turn ? 'we tax' : 'they tax');
            cash[turn] += 3;
        }
        function income() {
            debug(turn ? 'we income' : 'they income');
            cash[turn]++;
        }
        function coup() {
            debug(turn ? 'we coup' : 'they coup');
            cash[turn] -= 7;
            influenceCount[other] -= 1;
        }
        // Apply the pending move
        if (state.state.name == stateNames.ACTION_RESPONSE) {
            // The opponent is playing an action; simulate it (unless we are blocking), then run from our turn
            i = 0;
            turn = 0;
            other = 1
            if (!bluffedRole) {
                switch (state.state.action) {
                    case 'steal':
                        steal();
                        break;
                    case 'assassinate':
                        assassinate();
                        break;
                    case 'tax':
                        tax();
                        break;
                    default:
                        debug('unexpected initial action: ' + state.state.action);
                }
                debug('their cash: ' + cash[0]);
                debug('our cash: ' + cash[1]);
            }
        } else if (state.state.name == stateNames.BLOCK_RESPONSE) {
            // The opponent is blocking our action; run from the opponent's turn
            i = 1;
        } else if (state.state.name == stateNames.START_OF_TURN) {
            // It's our turn and we are considering a bluff; run from our turn
            i = 0;
        }
        while (i < options.searchHorizon) {
            i++;
            turn = i % 2;
            other = (i + 1) % 2;
            if (influenceCount[0] == 0) {
                debug('we win simulation');
                return 1;
            }
            if (influenceCount[1] == 0) {
                debug('they win simulation');
                return -1;
            }
            if (canAssassinate() && cash[turn] >= 3) {
                assassinate();
            } else if (cash[turn] >= 7) {
                coup();
            } else if (canSteal() && cash[other] > 0) {
                // To do: only steal if cash >= 2, e.g., if they also have the duke?
                steal();
            } else if (canTax()) {
                tax();
            } else {
                income();
            }
            debug('their cash: ' + cash[0]);
            debug('our cash: ' + cash[1]);
        }
        debug('search horizon exceeded while simulating endgame')
        // We don't know if we would win, but don't do anything rash
        return 0;
    }

    function debug(msg) {
        options.debug && console.log(JSON.stringify(msg, null, 4));
    }

    function handleError(e) {
        if (e instanceof Error) {
            console.error(e);
            console.error(e.stack);
        }
    }
}

module.exports = createAiPlayer;
