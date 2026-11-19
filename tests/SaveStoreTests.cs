using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace JianghuChroniclesSaveEditorTests
{
    internal static class SaveStoreTests
    {
        private const string PlayerType = "SGame.PlayerGameData";
        private const string StoreType = "SGame.StoreData";
        private const string SimulationKey = "JHL_SIMULATE_GAME_RUNNING";
        private static Type storeType;
        private static object store;

        private static int Main()
        {
            string directory = Path.Combine(Path.GetTempPath(), "jhl-tests-" + Guid.NewGuid().ToString("N"));
            string previousSimulation = Environment.GetEnvironmentVariable(SimulationKey);
            try
            {
                Directory.CreateDirectory(directory);
                Environment.SetEnvironmentVariable(SimulationKey, null);
                storeType = FindSaveStore();
                ConstructorInfo rootedConstructor = storeType.GetConstructor(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, new[] { typeof(string) }, null);
                ConstructorInfo defaultConstructor = storeType.GetConstructor(
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance,
                    null, Type.EmptyTypes, null);
                if (rootedConstructor != null)
                    store = rootedConstructor.Invoke(new object[] { directory });
                else if (defaultConstructor != null)
                    store = defaultConstructor.Invoke(new object[0]);

                TestPaths(directory);
                TestDetectKind(directory);
                TestSaveAndRestore(directory);
                Directory.Delete(directory, true);
                Console.WriteLine("SaveStoreTests passed all cases.");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
            finally
            {
                Environment.SetEnvironmentVariable(SimulationKey, previousSimulation);
                if (Directory.Exists(directory))
                {
                    try
                    {
                        Directory.Delete(directory, true);
                    }
                    catch (IOException error)
                    {
                        Console.Error.WriteLine(error.Message);
                    }
                    catch (UnauthorizedAccessException error)
                    {
                        Console.Error.WriteLine(error.Message);
                    }
                }
            }
        }

        private static Type FindSaveStore()
        {
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type match = assembly.GetTypes().FirstOrDefault(type => type.Name == "SaveStore");
                if (match != null)
                    return match;
            }

            foreach (string file in Directory.GetFiles(AppDomain.CurrentDomain.BaseDirectory))
            {
                string extension = Path.GetExtension(file);
                if (!extension.Equals(".dll", StringComparison.OrdinalIgnoreCase) &&
                    !extension.Equals(".exe", StringComparison.OrdinalIgnoreCase))
                    continue;
                try
                {
                    Type match = Assembly.LoadFrom(file).GetTypes().FirstOrDefault(type => type.Name == "SaveStore");
                    if (match != null)
                        return match;
                }
                catch (BadImageFormatException)
                {
                    // Native binaries can be present alongside the editor.
                }
                catch (ReflectionTypeLoadException error)
                {
                    Type match = error.Types.FirstOrDefault(type => type != null && type.Name == "SaveStore");
                    if (match != null)
                        return match;
                }
            }

            throw new InvalidOperationException("Compile with SaveStore or place its assembly beside this test executable.");
        }

        private static object Call(string name, string directory, string path, byte[] bytes,
            string baseSha256, string backupPath)
        {
            foreach (MethodInfo method in storeType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic |
                BindingFlags.Static | BindingFlags.Instance).Where(candidate => candidate.Name == name)
                .OrderByDescending(candidate => candidate.GetParameters().Any(p => p.ParameterType == typeof(byte[]))))
            {
                if (!method.IsStatic && store == null)
                    continue;
                ParameterInfo[] parameters = method.GetParameters();
                object[] values = new object[parameters.Length];
                bool supported = true;
                for (int i = 0; i < parameters.Length; i++)
                {
                    ParameterInfo parameter = parameters[i];
                    string key = parameter.Name.ToLowerInvariant();
                    Type type = parameter.ParameterType;
                    if (parameter.IsOut)
                        values[i] = null;
                    else if (type == typeof(byte[]))
                        values[i] = bytes;
                    else if (type == typeof(string))
                    {
                        if (key.Contains("sha") || key.Contains("hash"))
                            values[i] = baseSha256;
                        else if (key.Contains("backup"))
                            values[i] = key.EndsWith("id") || key.EndsWith("name")
                                ? Path.GetFileName(backupPath) : backupPath;
                        else if (key.Contains("root") || key == "dir" || key.Contains("directory") || key.EndsWith("dir"))
                            values[i] = directory;
                        else if (key.Contains("relative") || key.EndsWith("name"))
                            values[i] = Path.IsPathRooted(path) && path.StartsWith(
                                directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                                ? path.Substring(directory.Length + 1) : path;
                        else
                            values[i] = path;
                    }
                    else if (parameter.IsOptional)
                        values[i] = Type.Missing;
                    else
                    {
                        supported = false;
                        break;
                    }
                }
                if (!supported)
                    continue;

                object result;
                try
                {
                    result = method.Invoke(method.IsStatic ? null : store, values);
                }
                catch (TargetInvocationException error)
                {
                    throw new SaveStoreFailure(error.InnerException);
                }

                if (result is bool && !(bool)result)
                {
                    string details = string.Join(" ", parameters.Select((p, i) => p.IsOut ? values[i] : null)
                        .Where(value => value != null).Select(value => value.ToString()).ToArray());
                    throw new SaveStoreFailure(details);
                }

                if (result is bool && (bool)result)
                {
                    for (int i = 0; i < parameters.Length; i++)
                    {
                        if (parameters[i].IsOut && parameters[i].Name.IndexOf("kind",
                            StringComparison.OrdinalIgnoreCase) >= 0)
                            return values[i];
                    }
                }

                object success = ReadMember(result, "Success") ?? ReadMember(result, "Ok") ??
                    ReadMember(result, "IsSuccess");
                string status = Convert.ToString(ReadMember(result, "Code") ??
                    ReadMember(result, "ErrorCode") ?? ReadMember(result, "Status"));
                if ((success is bool && !(bool)success) ||
                    status.Equals("CONFLICT", StringComparison.OrdinalIgnoreCase) ||
                    status.IndexOf("GAME_RUNNING", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    throw new SaveStoreFailure(status + " " + Convert.ToString(
                        ReadMember(result, "Message") ?? ReadMember(result, "Error")));
                }

                return result;
            }

            throw new InvalidOperationException("No compatible SaveStore." + name + " method was found.");
        }

        private static object ReadMember(object instance, string name)
        {
            if (instance == null)
                return null;
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase;
            PropertyInfo property = instance.GetType().GetProperty(name, flags);
            if (property != null && property.GetIndexParameters().Length == 0)
                return property.GetValue(instance, null);
            FieldInfo field = instance.GetType().GetField(name, flags);
            return field == null ? null : field.GetValue(instance);
        }

        private static void TestPaths(string directory)
        {
            string safePath = Path.Combine(directory, "safe.sav");
            File.WriteAllBytes(safePath, MakeSave(PlayerType, 1));
            Call("ValidateSafePath", directory, safePath, null, null, null);

            foreach (string invalid in new[] { @"\\server\share\a.sav", "foo.sav:bar", "CON", "NUL" })
            {
                string candidate = Path.IsPathRooted(invalid) ? invalid : Path.Combine(directory, invalid);
                ExpectRejected(() => Call("ValidateSafePath", directory, candidate, null, null, null), invalid, null);
            }

            string real = Path.Combine(directory, "actual");
            string junction = Path.Combine(directory, "junction");
            Directory.CreateDirectory(real);
            File.Copy(safePath, Path.Combine(real, "safe.sav"));
            var startInfo = new ProcessStartInfo("cmd.exe", "/d /c mklink /J \"" + junction + "\" \"" + real + "\"");
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            using (Process process = Process.Start(startInfo))
            {
                process.WaitForExit();
                Check(process.ExitCode == 0, "mklink /J failed with exit code " + process.ExitCode);
            }

            try
            {
                Check((File.GetAttributes(junction) & FileAttributes.ReparsePoint) != 0,
                    "Expected a junction reparse point.");
                ExpectRejected(() => Call("ValidateSafePath", directory, Path.Combine(junction, "safe.sav"),
                    null, null, null), "junction traversal", null);
            }
            finally
            {
                Directory.Delete(junction);
            }
        }

        private static void TestDetectKind(string directory)
        {
            string file = Path.Combine(directory, "kind.sav");
            byte[] player = MakeSave(PlayerType, 1);
            byte[] storeBytes = MakeSave(StoreType, 1);
            string playerKind = KindName(Detect(directory, file, player));
            string storeKind = KindName(Detect(directory, file, storeBytes));
            Check(playerKind.IndexOf("Player", StringComparison.OrdinalIgnoreCase) >= 0,
                "Unexpected player kind: " + playerKind);
            Check(storeKind.IndexOf("Store", StringComparison.OrdinalIgnoreCase) >= 0,
                "Unexpected store kind: " + storeKind);
            Check(!playerKind.Equals(storeKind, StringComparison.OrdinalIgnoreCase), "Save kinds must differ.");

            byte[] corruptedHeader = (byte[])player.Clone();
            corruptedHeader[0] = 255;
            byte[] corruptedEnd = (byte[])player.Clone();
            corruptedEnd[corruptedEnd.Length - 1] = 255;
            foreach (byte[] invalid in new[] {
                player.Take(8).ToArray(), player.Take(player.Length - 1).ToArray(),
                corruptedHeader, corruptedEnd, MakeSave("SGame.UnsupportedData", 1)
            })
            {
                try
                {
                    string detected = KindName(Detect(directory, file, invalid));
                    Check(detected.Length == 0 || detected.Equals("Unknown", StringComparison.OrdinalIgnoreCase) ||
                        detected.Equals("Invalid", StringComparison.OrdinalIgnoreCase) ||
                        detected.Equals("Unsupported", StringComparison.OrdinalIgnoreCase) ||
                        detected.Equals("None", StringComparison.OrdinalIgnoreCase),
                        "DetectKind accepted invalid data as " + detected);
                }
                catch (SaveStoreFailure error)
                {
                    Check(!(error.InnerException is NullReferenceException) &&
                        !(error.InnerException is IndexOutOfRangeException),
                        "DetectKind crashed on invalid data: " + error);
                }
            }
        }

        private static object Detect(string directory, string file, byte[] bytes)
        {
            File.WriteAllBytes(file, bytes);
            return Call("DetectKind", directory, file, bytes, null, null);
        }

        private static string KindName(object result)
        {
            return Convert.ToString(ReadMember(result, "Kind") ?? result);
        }

        private static void TestSaveAndRestore(string directory)
        {
            string file = Path.Combine(directory, "player.sav");
            byte[] original = MakeSave(PlayerType, 1);
            byte[] changed = MakeSave(PlayerType, 2);
            File.WriteAllBytes(file, original);

            Call("SaveWithBackup", directory, file, changed, Sha256(original), null);
            AssertFile(file, changed);
            string[] backups = Backups(directory);
            Check(backups.Length == 1, "Expected one .jhl_backups backup after the first save.");
            AssertFile(backups[0], original);
            string firstBackup = backups[0];

            byte[] third = MakeSave(PlayerType, 3);
            ExpectRejected(() => Call("SaveWithBackup", directory, file, third, Sha256(original), null),
                "stale base SHA-256", "CONFLICT");
            AssertFile(file, changed);
            Check(Backups(directory).SequenceEqual(backups), "Conflict changed the backup set.");

            Environment.SetEnvironmentVariable(SimulationKey, "1");
            try
            {
                ExpectRejected(() => Call("SaveWithBackup", directory, file, third, Sha256(changed), null),
                    "game running", null);
                AssertFile(file, changed);
                Check(Backups(directory).SequenceEqual(backups), "Game-running rejection changed the backup set.");
            }
            finally
            {
                Environment.SetEnvironmentVariable(SimulationKey, null);
            }

            Call("RestoreBackup", directory, file, null, Sha256(changed), firstBackup);
            AssertFile(file, original);

            byte[] current = original;
            for (int i = 0; i < 25; i++)
            {
                byte[] next = MakeSave(PlayerType, 100 + i);
                Call("SaveWithBackup", directory, file, next, Sha256(current), null);
                AssertFile(file, next);
                int count = Backups(directory).Length;
                Check(count <= 20, "The backup retention cap was exceeded.");
                if (i >= 19)
                    Check(count == 20, "Expected 20 backups after reaching the retention limit.");
                current = next;
            }
        }

        private static string[] Backups(string directory)
        {
            string backupDirectory = Path.Combine(directory, ".jhl_backups");
            return Directory.Exists(backupDirectory)
                ? Directory.GetFiles(backupDirectory, "*.bak.*").OrderBy(file => file, StringComparer.Ordinal).ToArray()
                : new string[0];
        }

        private static byte[] MakeSave(string className, int money)
        {
            using (var stream = new MemoryStream())
            using (var writer = new BinaryWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write((byte)0); // SerializedStreamHeader
                writer.Write(1);       // Root object ID
                writer.Write(-1);      // Header ID
                writer.Write(1);       // Major version
                writer.Write(0);       // Minor version
                writer.Write((byte)12); // BinaryLibrary
                writer.Write(2);
                writer.Write("Assembly-CSharp");
                writer.Write((byte)5);  // ClassWithMembersAndTypes
                writer.Write(1);
                writer.Write(className);
                writer.Write(1);
                writer.Write("money");
                writer.Write((byte)0);  // BinaryType.Primitive
                writer.Write((byte)8);  // PrimitiveType.Int32
                writer.Write(2);        // Library ID
                writer.Write(money);
                writer.Write((byte)11); // MessageEnd
                writer.Flush();
                return stream.ToArray();
            }
        }

        private static string Sha256(byte[] bytes)
        {
            using (SHA256 algorithm = SHA256.Create())
                return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }

        private static void AssertFile(string path, byte[] expected)
        {
            byte[] actual = File.ReadAllBytes(path);
            Check(actual.SequenceEqual(expected), "Unexpected file bytes at " + path);
            Check(Sha256(actual) == Sha256(expected), "Unexpected SHA-256 at " + path);
        }

        private static void ExpectRejected(Action action, string description, string expectedCode)
        {
            try
            {
                action();
            }
            catch (SaveStoreFailure error)
            {
                Check(!(error.InnerException is NullReferenceException) &&
                    !(error.InnerException is IndexOutOfRangeException),
                    "Unexpected crash while checking " + description + ": " + error);
                if (expectedCode != null)
                    Check(error.ToString().IndexOf(expectedCode, StringComparison.OrdinalIgnoreCase) >= 0,
                        "Expected " + expectedCode + " for " + description + ": " + error);
                return;
            }

            throw new InvalidOperationException("Expected SaveStore to reject " + description + ".");
        }

        private static void Check(bool condition, string message)
        {
            if (!condition)
                throw new InvalidOperationException(message);
        }

        private sealed class SaveStoreFailure : Exception
        {
            public SaveStoreFailure(string message) : base(message) { }
            public SaveStoreFailure(Exception cause) : base(cause.Message, cause) { }
        }
    }
}
