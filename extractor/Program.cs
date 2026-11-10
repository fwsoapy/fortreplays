// FortReplayExtract: reads the network stream of a Fortnite replay and prints
// one JSON object with the things only that stream contains.
//
//   team index      the game's own team number, so squads are exact
//   display name    decoded from the stream, so no online lookup is needed
//   placement       final position of that player's team
//
// Damage is deliberately not reported. The stream does carry damage cues, but
// summing them could not be reconciled with the damage figure the game itself
// writes into the replay (it came out between 0.9x and 5.5x depending on the
// match), so there is no number here that would be safe to trust.

using System.Text.Json;
using FortniteReplayReader;
using FortniteReplayReader.Models.NetFieldExports;
using Unreal.Core.Contracts;
using Unreal.Core.Models;
using Unreal.Core.Models.Enums;

class Extractor : ReplayReader
{
    public Extractor() : base(null, ParseMode.Full) { }

    class Record
    {
        public string? Id, BotId, Name;
        public int? Team, Placement, Kills;
        public bool IsBot;
    }

    readonly Dictionary<uint, Record> _byStateChannel = new();
    readonly Dictionary<uint, string> _nameByChannel = new();
    readonly Dictionary<uint, uint> _actorToChannel = new();
    uint? _recorderActor;

    Record For(uint channel)
    {
        if (!_byStateChannel.TryGetValue(channel, out var record))
        {
            record = new Record();
            _byStateChannel[channel] = record;
        }
        return record;
    }

    protected override void OnExternalDataRead(uint channel, IExternalData data)
    {
        if (data == null) return;
        var decoded = new PlayerNameData(data.Archive);
        if (decoded.IsPlayer && !string.IsNullOrWhiteSpace(decoded.DecodedName))
        {
            _nameByChannel[channel] = decoded.DecodedName;
        }
    }

    protected override void OnChannelOpened(uint channel, NetworkGUID actor)
    {
        _actorToChannel[actor.Value] = channel;
    }

    protected override void OnExportRead(uint channel, INetFieldExportGroup group)
    {
        // The game state names the player state of whoever recorded this file,
        // which is how a teammate's replay can be told apart from your own.
        if (group is GameState gameState)
        {
            if (gameState.RecorderPlayerState.Value != 0)
            {
                _recorderActor = gameState.RecorderPlayerState.Value;
            }
            return;
        }

        if (group is not FortPlayerState state) return;

        var record = For(channel);
        var id = state.UniqueId ?? state.UniqueID;
        if (!string.IsNullOrEmpty(id)) record.Id = id;
        if (!string.IsNullOrEmpty(state.BotUniqueId)) record.BotId = state.BotUniqueId;
        if (state.bIsABot == true) record.IsBot = true;
        if (state.TeamIndex.HasValue) record.Team = state.TeamIndex;
        if (state.Place.HasValue) record.Placement = state.Place;
        if (state.KillScore.HasValue) record.Kills = (int?)state.KillScore;

        var custom = state.PlayerNameCustomOverride?.Text;
        if (!string.IsNullOrWhiteSpace(custom)) record.Name ??= custom;
        if (_nameByChannel.TryGetValue(channel, out var streamed)) record.Name ??= streamed;
    }

    public object Build(FortniteReplayReader.Models.FortniteReplay replay)
    {
        var players = _byStateChannel.Values
            .Where(r => !string.IsNullOrEmpty(r.Id) || !string.IsNullOrEmpty(r.BotId))
            .GroupBy(r => (r.Id ?? r.BotId)!.ToLowerInvariant())
            .Select(g => new
            {
                id = g.Key,
                name = g.Select(r => r.Name).FirstOrDefault(n => !string.IsNullOrWhiteSpace(n)),
                team = g.Select(r => r.Team).FirstOrDefault(t => t.HasValue),
                placement = g.Select(r => r.Placement).FirstOrDefault(p => p.HasValue),
                kills = g.Max(r => r.Kills),
                isBot = g.Any(r => r.IsBot),
            })
            .ToList();

        string? recorderId = null;
        if (_recorderActor.HasValue
            && _actorToChannel.TryGetValue(_recorderActor.Value, out var recorderChannel)
            && _byStateChannel.TryGetValue(recorderChannel, out var recorder))
        {
            recorderId = (recorder.Id ?? recorder.BotId)?.ToLowerInvariant();
        }

        return new
        {
            ok = true,
            recorderId,
            players,
        };
    }
}

class Program
{
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || !File.Exists(args[0]))
            {
                Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = "replay not found" }));
                return 1;
            }

            var extractor = new Extractor();
            var replay = extractor.ReadReplay(args[0]);
            Console.WriteLine(JsonSerializer.Serialize(extractor.Build(replay)));
            return 0;
        }
        catch (Exception exception)
        {
            // The app treats a failure here as "no extra data", never as a
            // failed import, so a broken network stream still leaves the
            // event-chunk stats intact.
            Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = exception.Message }));
            return 1;
        }
    }
}
