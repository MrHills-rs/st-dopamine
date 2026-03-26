import { extension_settings, getContext, registerDebugFunction } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { localforage } from '../../../../lib.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

const storage = localforage.createInstance({ name: 'SillyTavern_Dopamine' });
const extensionPromptMarker = '___Dopamine___';

const defaultSettings = {
    minTimerMinutes: 10,
    maxTimerHours: 72,
    pollingIntervalSeconds: 30,
};

/**
 * Timer/Alarm structure
 * @typedef {Object} Timer
 * @property {string} id - Unique identifier
 * @property {'timer'|'alarm'} type - Type of reminder
 * @property {string} reminder_text - Message to send when triggered
 * @property {number} createdAt - Timestamp when created
 * @property {number} triggerAt - Timestamp when this should fire
 * @property {string|null} alarmTime - For alarms: HH:mm format
 * @property {string[]} days - For alarms: array of day names (empty = one-off)
 * @property {boolean} active - Whether this is still active
 */

/**
 * Generates a unique ID for timers/alarms
 */
function generateId() {
    return `dopamine_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gets the next occurrence of a time on specific days
 * @param {string} time - HH:mm format
 * @param {string[]} days - Array of day names (e.g., ['Monday', 'Tuesday'])
 * @returns {number} - Timestamp of next occurrence
 */
function getNextAlarmTime(time, days) {
    const now = new Date();
    const [hours, minutes] = time.split(':').map(Number);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = now.getDay();

    // If no days specified, it's a one-off alarm for today (or tomorrow if time has passed)
    if (!days || days.length === 0) {
        const alarm = new Date(now);
        alarm.setHours(hours, minutes, 0, 0);
        if (alarm <= now) {
            alarm.setDate(alarm.getDate() + 1);
        }
        return alarm.getTime();
    }

    // Find the next day in the array
    for (let i = 0; i <= 7; i++) {
        const checkDay = (currentDay + i) % 7;
        const checkDayName = dayNames[checkDay];

        if (days.includes(checkDayName)) {
            const alarm = new Date(now);
            alarm.setDate(now.getDate() + i);
            alarm.setHours(hours, minutes, 0, 0);

            // If it's today and time has passed, skip to next week
            if (i === 0 && alarm <= now) {
                continue;
            }

            return alarm.getTime();
        }
    }

    // Fallback: next occurrence in a week
    return getNextAlarmTime(time, days);
}

/**
 * Loads all timers and alarms from storage
 * @returns {Promise<{timers: Timer[], alarms: Timer[]}>}
 */
async function loadAllTimers() {
    const all = await storage.getItem('all_timers') || [];
    const now = Date.now();

    // Filter out inactive/expired items
    const active = all.filter(t => t.active && (t.type === 'alarm' || t.triggerAt > now));

    return {
        timers: active.filter(t => t.type === 'timer'),
        alarms: active.filter(t => t.type === 'alarm'),
    };
}

/**
 * Saves all timers and alarms to storage
 * @param {{timers: Timer[], alarms: Timer[]}} data
 */
async function saveAllTimers(data) {
    const all = [...data.timers, ...data.alarms];
    await storage.setItem('all_timers', all);
}

/**
 * Deletes a timer or alarm by ID
 * @param {string} id
 * @returns {Promise<boolean>} - True if deleted
 */
async function deleteTimerById(id) {
    const { timers, alarms } = await loadAllTimers();
    const timerIndex = timers.findIndex(t => t.id === id);
    const alarmIndex = alarms.findIndex(t => t.id === id);

    if (timerIndex >= 0) {
        timers.splice(timerIndex, 1);
        await saveAllTimers({ timers, alarms });
        return true;
    }

    if (alarmIndex >= 0) {
        alarms.splice(alarmIndex, 1);
        await saveAllTimers({ timers, alarms });
        return true;
    }

    return false;
}

/**
 * Formats a timestamp for display
 */
function formatTriggerTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
}

/**
 * Gets a summary of all timers and alarms for display
 */
async function getTimersSummary() {
    const { timers, alarms } = await loadAllTimers();

    const timerList = timers.map(t =>
        `• Timer ${t.id.substr(-8)}: "${t.reminder_text}" - triggers in ${Math.round((t.triggerAt - Date.now()) / 60000)} minutes`
    ).join('\n') || 'No active timers';

    const alarmList = alarms.map(a => {
        const nextTrigger = new Date(a.triggerAt);
        const dayStr = a.days.length > 0 ? `repeats on ${a.days.join(', ')}` : 'one-off';
        return `• Alarm ${a.id.substr(-8)}: "${a.reminder_text}" at ${a.alarmTime} (${dayStr}) - next: ${nextTrigger.toLocaleString()}`;
    }).join('\n') || 'No active alarms';

    return `**Active Timers:**\n${timerList}\n\n**Active Alarms:**\n${alarmList}`;
}

/**
 * Injects a tool message into the chat and triggers generation
 * @param {string} text - The message content
 */
async function injectToolMessage(text) {
    const context = getContext();

    // Add a tool message to the chat
    const toolMessage = {
        name: 'Dopamine',
        is_user: false,
        is_system: false,
        send_date: Date.now(),
        mes: text,
        extra: {
            type: 'tool_result',
            tool_name: 'dopamine_timer',
        },
    };

    context.chat.push(toolMessage);

    // Add to UI using the exported addOneMessage
    const { addOneMessage, Generate } = SillyTavern.getContext();

    if (addOneMessage) {
        addOneMessage(toolMessage, { scroll: true, showSwipes: false });
    }

    // Trigger generation after a short delay
    if (Generate) {
        setTimeout(() => {
            try {
                Generate('normal', {}, false);
            } catch (e) {
                console.error('[Dopamine] Generation trigger failed:', e);
            }
        }, 200);
    }
}


/**
 * Checks for expired timers and triggers them
 */
async function checkExpiredTimers() {
    const { timers, alarms } = await loadAllTimers();
    const now = Date.now();
    let changed = false;

    // Check regular timers
    for (const timer of timers) {
        if (timer.triggerAt <= now && timer.active) {
            // Timer expired - trigger it
            await injectToolMessage(`⏰ **Timer Alert!**\n\n${timer.reminder_text}\n\nTimer ID: \`${timer.id}\`\nSet: ${formatTriggerTime(timer.createdAt)}\nTriggered: ${formatTriggerTime(now)}`);

            // Deactivate the timer
            timer.active = false;
            changed = true;
        }
    }

    // Check alarms
    for (const alarm of alarms) {
        if (alarm.triggerAt <= now && alarm.active) {
            // Alarm triggered
            await injectToolMessage(`⏰ **Alarm!**\n\n${alarm.reminder_text}\n\nAlarm ID: \`${alarm.id}\`\nTime: ${alarm.alarmTime}\n${alarm.days.length > 0 ? `Repeats: ${alarm.days.join(', ')}` : 'One-off alarm'}`);

            // For repeating alarms, calculate next occurrence
            if (alarm.days && alarm.days.length > 0) {
                alarm.triggerAt = getNextAlarmTime(alarm.alarmTime, alarm.days);
                // Don't deactivate - keep it active for next occurrence
            } else {
                // One-off alarm - deactivate
                alarm.active = false;
            }

            changed = true;
        }
    }

    if (changed) {
        await saveAllTimers({ timers, alarms });
    }
}

/**
 * Starts the polling interval to check for expired timers
 */
let pollingInterval = null;

function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }

    const intervalMs = (extension_settings.dopamine?.pollingIntervalSeconds || defaultSettings.pollingIntervalSeconds) * 1000;
    pollingInterval = setInterval(checkExpiredTimers, intervalMs);
    console.log(`[Dopamine] Polling started every ${intervalMs / 1000} seconds`);
}

function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log('[Dopamine] Polling stopped');
    }
}

/**
 * Registers the function tools with SillyTavern
 */
function registerFunctionTools() {
    try {
        const { registerFunctionTool, unregisterFunctionTool } = getContext();

        if (!registerFunctionTool || !unregisterFunctionTool) {
            console.log('[Dopamine] Function tools are not supported');
            return;
        }

        // Check if dopamine is enabled
        if (!extension_settings.dopamine?.enabled) {
            unregisterFunctionTool('Dopamine_SetTimer');
            unregisterFunctionTool('Dopamine_SetAlarm');
            unregisterFunctionTool('Dopamine_CheckAlarms');
            unregisterFunctionTool('Dopamine_DeleteAlarm');
            return;
        }

        // ========== SET TIMER TOOL ==========
        const setTimerSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                interval: {
                    type: 'number',
                    description: `Timer interval in minutes (minimum: ${defaultSettings.minTimerMinutes}, maximum: ${defaultSettings.maxTimerHours * 60})`,
                    minimum: defaultSettings.minTimerMinutes,
                    maximum: defaultSettings.maxTimerHours * 60,
                },
                reminder_text: {
                    type: 'string',
                    description: 'The reminder message to send when the timer expires',
                },
            },
            required: ['interval', 'reminder_text'],
        });

        registerFunctionTool({
            name: 'Dopamine_SetTimer',
            displayName: 'Set Timer',
            description: `Sets a timer that will send a reminder after the specified interval. Minimum: ${defaultSettings.minTimerMinutes} minutes, Maximum: ${defaultSettings.maxTimerHours} hours. Returns the timer ID and a list of all active timers and alarms.`,
            parameters: setTimerSchema,
            formatMessage: (args) => {
                if (!args?.interval) return '';
                return `Setting a timer for ${args.interval} minutes`;
            },
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                if (!args.interval) throw new Error('No interval provided');
                if (!args.reminder_text) throw new Error('No reminder text provided');

                const intervalMinutes = Number(args.interval);
                const minMinutes = extension_settings.dopamine?.minTimerMinutes || defaultSettings.minTimerMinutes;
                const maxMinutes = (extension_settings.dopamine?.maxTimerHours || defaultSettings.maxTimerHours) * 60;

                if (intervalMinutes < minMinutes) {
                    throw new Error(`Interval must be at least ${minMinutes} minutes`);
                }
                if (intervalMinutes > maxMinutes) {
                    throw new Error(`Interval must be at most ${maxMinutes} minutes (${maxMinutes / 60} hours)`);
                }

                const { timers, alarms } = await loadAllTimers();

                const newTimer = {
                    id: generateId(),
                    type: 'timer',
                    reminder_text: String(args.reminder_text),
                    createdAt: Date.now(),
                    triggerAt: Date.now() + (intervalMinutes * 60 * 1000),
                    active: true,
                };

                timers.push(newTimer);
                await saveAllTimers({ timers, alarms });

                const summary = await getTimersSummary();

                return {
                    success: true,
                    timer_id: newTimer.id,
                    trigger_at: formatTriggerTime(newTimer.triggerAt),
                    interval_minutes: intervalMinutes,
                    all_timers_summary: summary,
                };
            },
        });

        // ========== SET ALARM TOOL ==========
        const setAlarmSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                time: {
                    type: 'string',
                    description: 'Time in HH:mm format (24-hour), e.g., "08:00" or "14:30"',
                    pattern: '^([01]?[0-9]|2[0-3]):[0-5][0-9]$',
                },
                days: {
                    type: 'array',
                    items: {
                        type: 'string',
                        enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
                    },
                    description: 'Days of the week for the alarm to repeat. Empty array = one-off alarm',
                },
                reminder_text: {
                    type: 'string',
                    description: 'The reminder message to send when the alarm triggers',
                },
            },
            required: ['time', 'reminder_text'],
        });

        registerFunctionTool({
            name: 'Dopamine_SetAlarm',
            displayName: 'Set Alarm',
            description: 'Sets an alarm for a specific time. Can be one-off or repeating on specific days. Returns the alarm ID and a list of all active timers and alarms.',
            parameters: setAlarmSchema,
            formatMessage: (args) => {
                if (!args?.time) return '';
                const daysStr = args.days?.length > 0 ? `repeating on ${args.days.join(', ')}` : 'one-off';
                return `Setting an alarm for ${args.time} (${daysStr})`;
            },
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                if (!args.time) throw new Error('No time provided');
                if (!args.reminder_text) throw new Error('No reminder text provided');

                // Validate time format
                const timeMatch = String(args.time).match(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/);
                if (!timeMatch) {
                    throw new Error('Time must be in HH:mm format (24-hour)');
                }

                const { timers, alarms } = await loadAllTimers();

                const days = Array.isArray(args.days) ? args.days : [];
                const triggerAt = getNextAlarmTime(args.time, days);

                const newAlarm = {
                    id: generateId(),
                    type: 'alarm',
                    reminder_text: String(args.reminder_text),
                    createdAt: Date.now(),
                    alarmTime: args.time,
                    days: days,
                    triggerAt: triggerAt,
                    active: true,
                };

                alarms.push(newAlarm);
                await saveAllTimers({ timers, alarms });

                const summary = await getTimersSummary();

                return {
                    success: true,
                    alarm_id: newAlarm.id,
                    next_trigger: formatTriggerTime(newAlarm.triggerAt),
                    time: args.time,
                    repeating: days.length > 0,
                    days: days,
                    all_timers_summary: summary,
                };
            },
        });

        // ========== CHECK ALARMS TOOL ==========
        const checkAlarmsSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {},
        });

        registerFunctionTool({
            name: 'Dopamine_CheckAlarms',
            displayName: 'Check Timers & Alarms',
            description: 'Lists all active timers and alarms with their IDs, trigger times, and reminder texts.',
            parameters: checkAlarmsSchema,
            formatMessage: () => 'Checking all active timers and alarms',
            action: async () => {
                const summary = await getTimersSummary();

                return {
                    success: true,
                    summary: summary,
                };
            },
        });

        // ========== DELETE ALARM TOOL ==========
        const deleteAlarmSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                alarm_id: {
                    type: 'string',
                    description: 'The ID of the timer or alarm to delete',
                },
            },
            required: ['alarm_id'],
        });

        registerFunctionTool({
            name: 'Dopamine_DeleteAlarm',
            displayName: 'Delete Timer/Alarm',
            description: 'Deletes a timer or alarm by its ID. Returns confirmation and the updated list of all timers and alarms.',
            parameters: deleteAlarmSchema,
            formatMessage: (args) => {
                if (!args?.alarm_id) return '';
                return `Deleting timer/alarm ${args.alarm_id}`;
            },
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                if (!args.alarm_id) throw new Error('No alarm_id provided');

                const deleted = await deleteTimerById(String(args.alarm_id));

                if (!deleted) {
                    return {
                        success: false,
                        error: `Timer or alarm with ID ${args.alarm_id} not found`,
                    };
                }

                const summary = await getTimersSummary();

                return {
                    success: true,
                    deleted_id: args.alarm_id,
                    all_timers_summary: summary,
                };
            },
        });

        console.log('[Dopamine] Function tools registered successfully');
    } catch (error) {
        console.error('[Dopamine] Function tools failed to register:', error);
    }
}

/**
 * Renders the settings UI for the Dopamine extension
 */
async function renderSettings() {
    const container = document.getElementById('dopamine_settings_container');
    if (!container) return;

    const { timers, alarms } = await loadAllTimers();

    let html = '<div class="dopamine-timers-list">';
    html += '<h3>Active Timers</h3>';

    if (timers.length === 0) {
        html += '<p class="dopamine-empty">No active timers</p>';
    } else {
        html += '<ul class="dopamine-list">';
        for (const timer of timers) {
            const minutesLeft = Math.round((timer.triggerAt - Date.now()) / 60000);
            html += `<li class="dopamine-item">
                <span class="dopamine-id">${timer.id.substr(-8)}</span>
                <span class="dopamine-text">${timer.reminder_text}</span>
                <span class="dopamine-time">⏱ ${minutesLeft} min remaining</span>
            </li>`;
        }
        html += '</ul>';
    }

    html += '<h3>Active Alarms</h3>';

    if (alarms.length === 0) {
        html += '<p class="dopamine-empty">No active alarms</p>';
    } else {
        html += '<ul class="dopamine-list">';
        for (const alarm of alarms) {
            const nextTrigger = new Date(alarm.triggerAt);
            const dayStr = alarm.days.length > 0 ? `📅 ${alarm.days.join(', ')}` : '📌 One-off';
            html += `<li class="dopamine-item">
                <span class="dopamine-id">${alarm.id.substr(-8)}</span>
                <span class="dopamine-text">${alarm.reminder_text}</span>
                <span class="dopamine-time">⏰ ${alarm.alarmTime} ${dayStr}</span>
                <span class="dopamine-next">Next: ${nextTrigger.toLocaleString()}</span>
            </li>`;
        }
        html += '</ul>';
    }

    html += '</div>';

    container.innerHTML = html;
}

/**
 * Refreshes the settings UI periodically
 */
let settingsRefreshInterval = null;
let isSettingsPanelVisible = false;

function startSettingsRefresh() {
    if (settingsRefreshInterval) {
        clearInterval(settingsRefreshInterval);
    }

    // Refresh every 5 seconds when visible
    settingsRefreshInterval = setInterval(() => {
        if (isSettingsPanelVisible) {
            renderSettings();
        }
    }, 5000);
}

function stopSettingsRefresh() {
    if (settingsRefreshInterval) {
        clearInterval(settingsRefreshInterval);
        settingsRefreshInterval = null;
    }
}

// Track when settings panel is visible
jQuery(() => {
    const observer = new MutationObserver(() => {
        const container = document.getElementById('dopamine_settings_container');
        isSettingsPanelVisible = container && container.offsetParent !== null;
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class']
    });
});

window.addEventListener('beforeunload', () => {
    stopPolling();
    stopSettingsRefresh();
});


// ========== INITIALIZATION ==========

jQuery(async () => {
    // Initialize settings
    if (!extension_settings.dopamine) {
        extension_settings.dopamine = structuredClone(defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.dopamine[key] === undefined) {
            extension_settings.dopamine[key] = defaultSettings[key];
        }
    }

    // Render settings HTML
    try {
        const { renderExtensionTemplateAsync } = await import('../../../extensions.js');
        const html = await renderExtensionTemplateAsync('third-party/st-dopamine', 'settings');

        const getContainer = () => $(document.getElementById('dopamine_settings_container') ?? document.getElementById('extensions_settings2'));
        getContainer().append(html);

        // Bind settings controls
        $('#dopamine_min_timer').val(extension_settings.dopamine.minTimerMinutes);
        $('#dopamine_min_timer').on('change', () => {
            extension_settings.dopamine.minTimerMinutes = Number($('#dopamine_min_timer').val());
            saveSettingsDebounced();
        });

        $('#dopamine_max_timer').val(extension_settings.dopamine.maxTimerHours);
        $('#dopamine_max_timer').on('change', () => {
            extension_settings.dopamine.maxTimerHours = Number($('#dopamine_max_timer').val());
            saveSettingsDebounced();
        });

        $('#dopamine_polling_interval').val(extension_settings.dopamine.pollingIntervalSeconds);
        $('#dopamine_polling_interval').on('change', () => {
            extension_settings.dopamine.pollingIntervalSeconds = Number($('#dopamine_polling_interval').val());
            saveSettingsDebounced();
            startPolling(); // Restart with new interval
        });

        $('#dopamine_enabled').prop('checked', extension_settings.dopamine.enabled);
        $('#dopamine_enabled').on('change', () => {
            extension_settings.dopamine.enabled = !!$('#dopamine_enabled').prop('checked');
            registerFunctionTools();
            saveSettingsDebounced();

            if (extension_settings.dopamine.enabled) {
                startPolling();
                startSettingsRefresh();
            } else {
                stopPolling();
                stopSettingsRefresh();
            }
        });

        // Initial render of timers list
        renderSettings();
        startSettingsRefresh();
    } catch (error) {
        console.error('[Dopamine] Failed to render settings:', error);
    }

    // Register function tools
    registerFunctionTools();

    // Start polling if enabled
    if (extension_settings.dopamine?.enabled) {
        startPolling();
    }

    // Register debug functions
    registerDebugFunction('clearDopamineCache', 'Clear Dopamine timers', 'Deletes all active timers and alarms.', async () => {
        await storage.clear();
        console.log('[Dopamine] All timers cleared');
        toastr.success('[Dopamine] All timers and alarms cleared');
        renderSettings();
    });

    registerDebugFunction('listDopamineTimers', 'List Dopamine timers', 'Logs all active timers and alarms to console.', async () => {
        const { timers, alarms } = await loadAllTimers();
        console.log('[Dopamine] Active Timers:', timers);
        console.log('[Dopamine] Active Alarms:', alarms);
        toastr.info(`[Dopamine] ${timers.length} timers, ${alarms.length} alarms active`);
    });

    console.log('[Dopamine] Extension initialized');
});
