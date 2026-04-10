import { formatLocalTime } from './timezone.js';
export function escapeXml(s) {
    if (!s)
        return '';
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
export function formatMessages(messages, timezone) {
    const lines = messages.map((m) => {
        const displayTime = formatLocalTime(m.timestamp, timezone);
        const replyAttr = m.reply_to_message_id
            ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
            : '';
        const replySnippet = m.reply_to_message_content && m.reply_to_sender_name
            ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
            : '';
        return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
    });
    const header = `<context timezone="${escapeXml(timezone)}" />\n`;
    return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}
export function stripInternalTags(text) {
    return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
export function formatOutbound(rawText) {
    const text = stripInternalTags(rawText);
    if (!text)
        return '';
    return text;
}
export function routeOutbound(channels, jid, text) {
    const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
    if (!channel)
        throw new Error(`No channel for JID: ${jid}`);
    return channel.sendMessage(jid, text);
}
export function findChannel(channels, jid) {
    return channels.find((c) => c.ownsJid(jid));
}
//# sourceMappingURL=router.js.map