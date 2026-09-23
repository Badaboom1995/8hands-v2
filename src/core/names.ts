// Matching names the caller or model said (masters, studios, services)
// against the names we know. Provider-independent.

export function normalize(s: string): string {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function distance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]!;
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cur = row[j]!;
            row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
    }
    return row[b.length]!;
}

/**
 * Items whose name matches what the caller or model said, best tier only:
 * exact → every query word starts a word of the name → small typo distance.
 */
export function matchByName<T>(query: string, items: T[], name: (item: T) => string): T[] {
    const q = normalize(query);
    if (!q) return [];
    const exact = items.filter((i) => normalize(name(i)) === q);
    if (exact.length) return exact;

    const words = q.split(' ');
    const byWords = items.filter((i) => {
        const nameWords = normalize(name(i)).split(' ');
        return words.every((w) => nameWords.some((n) => n.startsWith(w)));
    });
    if (byWords.length) return byWords;

    const limit = Math.max(1, Math.floor(q.length / 4));
    return items.filter((i) => distance(normalize(name(i)), q) <= limit);
}
