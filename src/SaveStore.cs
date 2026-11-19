using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace JianghuChroniclesSaveEditor
{
    public class SaveSlotInfo
    {
        public string Path { get; set; }
        public string Name { get; set; }
        public string Kind { get; set; }
        public long Size { get; set; }
        public DateTime ModifiedUtc { get; set; }
        public string Sha256 { get; set; }
    }

    public class SaveReadResult
    {
        public string Path { get; set; }
        public string Kind { get; set; }
        public byte[] Bytes { get; set; }
        public string Sha256 { get; set; }
    }

    public class SaveWriteResult
    {
        public bool Success { get; set; }
        public string Path { get; set; }
        public string BackupPath { get; set; }
        public string NewSha256 { get; set; }
    }

    public class BackupInfo
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Path { get; set; }
        public long Size { get; set; }
        public DateTime ModifiedUtc { get; set; }
        public string Sha256 { get; set; }
    }

    public static class SaveStore
    {
        public const string SimulateRunningVar = "JHL_SIMULATE_GAME_RUNNING";
        public const int MaxSaveBytes = 32 * 1024 * 1024;
        public const int BackupLimit = 20;

        private const int OpenExisting = 3;
        private const int OpenAlways = 4;
        private const int CreateNew = 1;
        private const uint ReadAttributes = 0x80;
        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint NoFollow = 0x00200000 | 0x02000000;
        private const uint DirectoryAttribute = 0x10;
        private const uint ReparsePoint = 0x400;
        private const string BackupDirectory = ".jhl_backups";

        private static readonly byte[] Header =
        {
            0, 1, 0, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 0, 0, 0, 0
        };

        private static readonly byte[] PlayerType = Encoding.UTF8.GetBytes("SGame.PlayerGameData");
        private static readonly byte[] StoreType = Encoding.UTF8.GetBytes("SGame.StoreData");

        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME AccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME WriteTime;
            public uint VolumeSerialNumber;
            public uint SizeHigh;
            public uint SizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
            IntPtr security, int disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern bool MoveFileExW(string source, string destination, uint flags);

        public static string GetDefaultSaveDirectory()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "AppData", "LocalLow", "Yipinge", "JHL", "JHL_SAV");
        }

        public static bool IsGameRunning()
        {
            if (Environment.GetEnvironmentVariable(SimulateRunningVar) == "1")
                return true;

            Process[] processes = Process.GetProcesses();
            try
            {
                foreach (Process process in processes)
                {
                    string name;
                    try { name = process.ProcessName; }
                    catch (InvalidOperationException) { continue; }

                    if (Same(name, "JianghuChronicles") || Same(name, "JHL") || Same(name, "Jianghu"))
                        return true;
                }
                return false;
            }
            finally
            {
                foreach (Process process in processes)
                    process.Dispose();
            }
        }

        public static string ValidateSafePath(string path)
        {
            return ValidateSafePath(path, true);
        }

        public static string ValidateSafePath(string path, bool mustExist)
        {
            if (String.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0)
                throw new ArgumentException("Invalid path.", "path");

            path = path.Replace('/', '\\');
            if (path.StartsWith(@"\\", StringComparison.Ordinal) || path.IndexOf(':', 2) >= 0 ||
                path[0] == ':' || (path.Length > 1 && path[1] == ':' &&
                (path.Length < 3 || path[2] != '\\')))
                throw new ArgumentException("Invalid local path.", "path");

            CheckComponents(path);
            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full);
            if (root.Length != 3 || root[1] != ':')
                throw new ArgumentException("Expected a local drive path.", "path");

            CheckComponents(full);
            full = full.Length == root.Length ? root : full.TrimEnd('\\');
            using (PinParents(full))
            using (OpenChecked(full, ReadAttributes, 7, OpenExisting, !mustExist, false))
                return full;
        }

        private static void CheckComponents(string path)
        {
            if (path.Length >= 2 && path[1] == ':')
                path = path.Substring(2);

            foreach (string component in path.Split('\\'))
            {
                if (component.Length == 0 || component == "." || component == "..")
                    continue;

                string stem = component.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
                bool numbered = stem.Length == 4 &&
                    (stem.StartsWith("COM", StringComparison.Ordinal) ||
                     stem.StartsWith("LPT", StringComparison.Ordinal)) &&
                    "123456789\u00b9\u00b2\u00b3".IndexOf(stem[3]) >= 0;

                if (component.EndsWith(".", StringComparison.Ordinal) ||
                    component.EndsWith(" ", StringComparison.Ordinal) ||
                    component.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                    stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
                    stem == "CONIN$" || stem == "CONOUT$" || numbered)
                    throw new ArgumentException("Invalid path component.", "path");
            }
        }

        private sealed class DirectoryHandles : IDisposable
        {
            public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();

            public void Dispose()
            {
                for (int i = Handles.Count - 1; i >= 0; i--)
                    Handles[i].Dispose();
            }
        }

        private static DirectoryHandles PinParents(string path)
        {
            var handles = new DirectoryHandles();
            var parents = new Stack<string>();
            for (string parent = Path.GetDirectoryName(path); parent != null;
                parent = Path.GetDirectoryName(parent))
                parents.Push(parent);

            try
            {
                foreach (string parent in parents)
                {
                    var handle = OpenChecked(parent, ReadAttributes, 3, OpenExisting, true, true);
                    if (handle == null)
                        break;
                    handles.Handles.Add(handle);
                }
                return handles;
            }
            catch
            {
                handles.Dispose();
                throw;
            }
        }

        private static SafeFileHandle OpenChecked(string path, uint access, uint share,
            int disposition, bool allowMissing, bool requireDirectory)
        {
            SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero,
                disposition, NoFollow, IntPtr.Zero);
            int error = Marshal.GetLastWin32Error();
            if (handle.IsInvalid)
            {
                handle.Dispose();
                if (allowMissing && (error == 2 || error == 3))
                    return null;
                if (error == 2 || error == 3)
                    throw new FileNotFoundException("Path does not exist.", path);
                throw new IOException("Cannot open " + path, new Win32Exception(error));
            }

            try
            {
                FileInformation info = GetInformation(handle);
                bool directory = (info.Attributes & DirectoryAttribute) != 0;
                if ((info.Attributes & ReparsePoint) != 0 ||
                    (!directory && info.NumberOfLinks > 1) || (requireDirectory && !directory))
                    throw new IOException("Unsafe path: " + path);
                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        private static FileInformation GetInformation(SafeFileHandle handle)
        {
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new IOException("Cannot inspect file.", new Win32Exception(Marshal.GetLastWin32Error()));
            return info;
        }

        public static string DetectKind(byte[] bytes)
        {
            if (bytes == null || bytes.Length <= Header.Length || bytes[bytes.Length - 1] != 0x0B)
                throw new InvalidDataException("Invalid NRBF framing.");

            for (int i = 0; i < Header.Length; i++)
                if (bytes[i] != Header[i])
                    throw new InvalidDataException("Invalid NRBF header.");

            if (ContainsType(bytes, PlayerType))
                return "PlayerGameData";
            if (ContainsType(bytes, StoreType))
                return "StoreData";
            throw new InvalidDataException("Unknown save kind.");
        }

        private static bool ContainsType(byte[] bytes, byte[] type)
        {
            for (int i = Header.Length; i <= bytes.Length - 1 - type.Length; i++)
            {
                int j = 0;
                while (j < type.Length && bytes[i + j] == type[j])
                    j++;
                if (j == type.Length)
                    return true;
            }
            return false;
        }

        public static List<SaveSlotInfo> ListSaveSlots(string dirOverride)
        {
            string dir = ValidateSafePath(dirOverride ?? GetDefaultSaveDirectory(), false);
            var slots = new List<SaveSlotInfo>();
            using (PinParents(dir))
            using (var directory = OpenChecked(dir, ReadAttributes, 3, OpenExisting, true, true))
            {
                if (directory == null)
                    return slots;

                foreach (string path in Directory.EnumerateFiles(dir, "*.sav"))
                {
                    if (!Same(Path.GetExtension(path), ".sav"))
                        continue;
                    DateTime modified;
                    SaveReadResult save = ReadData(path, true, out modified);
                    slots.Add(new SaveSlotInfo
                    {
                        Path = save.Path, Name = Path.GetFileName(path), Kind = save.Kind,
                        Size = save.Bytes.Length, ModifiedUtc = modified, Sha256 = save.Sha256
                    });
                }
            }
            return slots;
        }

        public static SaveReadResult ReadSave(string path)
        {
            DateTime modified;
            return ReadData(ValidateSafePath(path, true), true, out modified);
        }

        private static SaveReadResult ReadData(string path, bool detectKind, out DateTime modified)
        {
            using (PinParents(path))
            using (var handle = OpenChecked(path, GenericRead, 1, OpenExisting, false, false))
            {
                FileInformation info = GetInformation(handle);
                if ((info.Attributes & DirectoryAttribute) != 0 ||
                    info.SizeHigh != 0 || info.SizeLow > MaxSaveBytes)
                    throw new InvalidDataException("Expected a save file of at most 32 MiB.");

                long ticks = ((long)(uint)info.WriteTime.dwHighDateTime << 32) |
                    (uint)info.WriteTime.dwLowDateTime;
                modified = DateTime.FromFileTimeUtc(ticks);
                byte[] bytes = new byte[(int)info.SizeLow];
                using (var stream = new FileStream(handle, FileAccess.Read))
                {
                    int offset = 0;
                    while (offset < bytes.Length)
                    {
                        int count = stream.Read(bytes, offset, bytes.Length - offset);
                        if (count == 0)
                            throw new EndOfStreamException();
                        offset += count;
                    }
                }

                return new SaveReadResult
                {
                    Path = path, Bytes = bytes, Sha256 = Hash(bytes),
                    Kind = detectKind ? DetectKind(bytes) : null
                };
            }
        }

        public static SaveWriteResult SaveWithBackup(string path, string baseSha256, byte[] newBytes)
        {
            return WriteSave(path, baseSha256, newBytes, out _ignoredResultHolder.Value);
        }

        private static class _ignoredResultHolder
        {
            [ThreadStatic]
            public static SaveReadResult Value;
        }

        private static SaveWriteResult WriteSave(string path, string baseSha256, byte[] newBytes,
            out SaveReadResult written)
        {
            EnsureGameStopped();
            path = ValidateSafePath(path, true);
            if (newBytes == null || newBytes.Length > MaxSaveBytes)
                throw new InvalidDataException("Expected save data of at most 32 MiB.");

            byte[] bytes = (byte[])newBytes.Clone();
            DetectKind(bytes);
            string expectedHash = Hash(bytes);
            string parent = Path.GetDirectoryName(path);
            if (parent == null)
                throw new IOException("Expected a save file.");
            string lockPath = Path.Combine(parent, ".jhl_store.lock");
            if (Same(path, lockPath))
                throw new IOException("Expected a save file.");

            using (PinParents(path))
            using (OpenChecked(lockPath, GenericRead | GenericWrite, 0, OpenAlways, false, false))
            {
                EnsureGameStopped();
                DateTime modified;
                SaveReadResult current = ReadData(path, true, out modified);
                if (!Same(baseSha256, current.Sha256))
                    throw new InvalidOperationException("CONFLICT: Current save SHA-256 differs from the base.");

                string backupDir = ValidateSafePath(Path.Combine(parent, BackupDirectory), false);
                Directory.CreateDirectory(backupDir);
                using (OpenChecked(backupDir, ReadAttributes, 3, OpenExisting, false, true))
                {
                    string name = Path.GetFileName(path);
                    string stamp = DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffffffZ", CultureInfo.InvariantCulture)
                        + "-" + Guid.NewGuid().ToString("N");
                    string backup = Path.Combine(backupDir, name + ".bak." + stamp + "." +
                        current.Sha256.Substring(0, 8));
                    WriteVerifiedNewFile(backup, current.Bytes, current.Sha256);

                    string temp = Path.Combine(parent, ".jhl-" + Guid.NewGuid().ToString("N") + ".tmp");
                    WriteVerifiedNewFile(temp, bytes, expectedHash);
                    bool moved = false;
                    try
                    {
                        EnsureGameStopped();
                        if (!Same(ReadData(path, true, out modified).Sha256, current.Sha256))
                            throw new InvalidOperationException("CONFLICT: Current save changed before replacement.");
                        if (!MoveFileExW(temp, path, 1 | 8))
                            throw new IOException("Cannot replace save.", new Win32Exception(Marshal.GetLastWin32Error()));
                        moved = true;
                        written = ReadData(path, true, out modified);
                        if (!Same(written.Sha256, expectedHash))
                            throw new IOException("Written save SHA-256 mismatch.");

                        TrimBackups(backupDir, name, backup);
                        return new SaveWriteResult
                        {
                            Success = true, Path = path, BackupPath = backup, NewSha256 = written.Sha256
                        };
                    }
                    finally
                    {
                        if (!moved)
                            File.Delete(temp);
                    }
                }
            }
        }

        private static void WriteVerifiedNewFile(string path, byte[] bytes, string expectedHash)
        {
            bool created = false;
            try
            {
                using (var handle = OpenChecked(path, GenericRead | GenericWrite, 0, CreateNew, false, false))
                {
                    created = true;
                    using (var stream = new FileStream(handle, FileAccess.ReadWrite))
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                        stream.Position = 0;
                        using (var sha = SHA256.Create())
                            if (!Same(Hex(sha.ComputeHash(stream)), expectedHash))
                                throw new IOException("File SHA-256 verification failed.");
                    }
                }
            }
            catch
            {
                if (created)
                    File.Delete(path);
                throw;
            }
        }

        public static List<BackupInfo> ListBackups(string targetSavePath)
        {
            string target = ValidateSafePath(targetSavePath, false);
            string dir = ValidateSafePath(Path.Combine(Path.GetDirectoryName(target), BackupDirectory), false);
            var backups = new List<BackupInfo>();
            using (PinParents(dir))
            using (var directory = OpenChecked(dir, ReadAttributes, 3, OpenExisting, true, true))
            {
                if (directory == null)
                    return backups;

                foreach (string path in Directory.EnumerateFiles(dir, "*.bak.*"))
                {
                    string name = Path.GetFileName(path);
                    if (name.IndexOf(".bak.", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;
                    DateTime modified;
                    SaveReadResult save = ReadData(path, false, out modified);
                    backups.Add(new BackupInfo
                    {
                        Id = name, Name = name, Path = path, Size = save.Bytes.Length,
                        ModifiedUtc = modified, Sha256 = save.Sha256
                    });
                }
            }
            backups.Sort(delegate(BackupInfo a, BackupInfo b)
            {
                int order = b.ModifiedUtc.CompareTo(a.ModifiedUtc);
                return order != 0 ? order : StringComparer.OrdinalIgnoreCase.Compare(b.Name, a.Name);
            });
            return backups;
        }

        private static void TrimBackups(string dir, string name, string newest)
        {
            string prefix = name + ".bak.";
            var paths = new List<string>();
            foreach (string path in Directory.EnumerateFiles(dir, "*.bak.*"))
                if (!Same(path, newest) && Path.GetFileName(path).StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    paths.Add(path);

            paths.Sort(delegate(string a, string b) { return StringComparer.OrdinalIgnoreCase.Compare(b, a); });
            for (int i = BackupLimit - 1; i < paths.Count; i++)
                File.Delete(ValidateSafePath(paths[i], true));
        }

        public static SaveReadResult RestoreBackup(string targetSavePath, string baseSha256, string backupPath)
        {
            EnsureGameStopped();
            string target = ValidateSafePath(targetSavePath, true);
            string backup = ValidateSafePath(backupPath, true);
            string dir = Path.Combine(Path.GetDirectoryName(target), BackupDirectory);
            string name = Path.GetFileName(backup);
            if (!Same(Path.GetDirectoryName(backup), dir) ||
                name.IndexOf(".bak.", StringComparison.OrdinalIgnoreCase) < 0)
                throw new IOException("Expected a backup in " + dir);

            SaveReadResult source = ReadSave(backup);
            SaveReadResult written;
            WriteSave(target, baseSha256, source.Bytes, out written);
            return written;
        }

        public static JavaScriptSerializer CreateSerializer()
        {
            return new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
        }

        private static void EnsureGameStopped()
        {
            if (IsGameRunning())
                throw new InvalidOperationException("Close the game before writing saves.");
        }

        private static bool Same(string first, string second)
        {
            return String.Equals(first, second, StringComparison.OrdinalIgnoreCase);
        }

        private static string Hash(byte[] bytes)
        {
            using (var sha = SHA256.Create())
                return Hex(sha.ComputeHash(bytes));
        }

        private static string Hex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }
    }
}