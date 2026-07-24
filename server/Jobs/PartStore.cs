//
// PartStore — in-memory registry of uploaded parts (ConcurrentDictionary).
//
// Files live on disk under {DataDir}/parts/{id}/; this registry is the runtime
// index. On startup it is intentionally EMPTY: pre-existing part folders on disk
// are ignored (not rehydrated). This keeps lifecycle simple — a fresh server has
// no parts until something is uploaded — which is acceptable for a single-user
// local app. (Documented deviation-free choice per the plan's "keep it simple".)
//
using System.Collections.Concurrent;

namespace Anvil.Server.Jobs;

public sealed class PartStore
{
    private readonly ConcurrentDictionary<string, PartInfo> _parts = new();

    public void Add(PartInfo p) => _parts[p.id] = p;

    public bool TryGet(string id, out PartInfo part) => _parts.TryGetValue(id, out part!);

    public PartInfo? Get(string id) => _parts.TryGetValue(id, out var p) ? p : null;

    public bool Remove(string id, out PartInfo? removed)
    {
        bool ok = _parts.TryRemove(id, out var p);
        removed = p;
        return ok;
    }

    public IReadOnlyCollection<PartInfo> All() => _parts.Values.ToList();
}
