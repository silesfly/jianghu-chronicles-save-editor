using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace JianghuChroniclesSaveEditor
{
    internal static class Program
    {
        internal const string Html = "JianghuChroniclesSaveEditor-v1.0.0.html";

        [STAThread]
        private static int Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveAssembly;
            bool selfTest = false;
            string output = Environment.CurrentDirectory;
            string seed = null;
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string option = args[i];
                    if (option == "--self-test")
                        selfTest = true;
                    else if ((option == "--out-dir" || option == "--seed") &&
                             i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    {
                        string value = Path.GetFullPath(args[++i]);
                        if (option == "--out-dir") output = value;
                        else seed = value;
                    }
                    else
                        throw new ArgumentException("Invalid argument: " + option);
                }

                string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "JianghuChroniclesSaveEditor");
                string runtime = Path.Combine(root, "runtime-1.0.0");
                using (Stream loader = OpenResource("WebView2Loader.dll"))
                {
                    if (loader != null)
                    {
                        Directory.CreateDirectory(runtime);
                        string destination = Path.Combine(runtime, "WebView2Loader.dll");
                        string temporary = destination + "." + Guid.NewGuid().ToString("N");
                        try
                        {
                            using (FileStream file = File.Create(temporary)) loader.CopyTo(file);
                            try { File.Move(temporary, destination); }
                            catch (IOException) { if (!File.Exists(destination)) throw; }
                        }
                        finally { File.Delete(temporary); }
                        SetLoaderDirectory(runtime);
                    }
                }

                return Run(root, selfTest, output, seed);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void SetLoaderDirectory(string path)
        {
            CoreWebView2Environment.SetLoaderDllFolderPath(path);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int Run(string root, bool selfTest, string output, string seed)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (EditorForm form = new EditorForm(root, selfTest, output, seed))
            {
                Application.Run(form);
                return form.ExitCode;
            }
        }

        internal static Stream OpenResource(string name)
        {
            Assembly assembly = typeof(Program).Assembly;
            foreach (string resource in assembly.GetManifestResourceNames())
                if (resource == name || resource.EndsWith("." + name, StringComparison.Ordinal))
                    return assembly.GetManifestResourceStream(resource);
            return null;
        }

        private static Assembly ResolveAssembly(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms")
                return null;

            string file = name + ".dll";
            using (Stream resource = OpenResource(file))
            {
                if (resource != null)
                    using (MemoryStream bytes = new MemoryStream())
                    {
                        resource.CopyTo(bytes);
                        return Assembly.Load(bytes.ToArray());
                    }
            }

            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, file);
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        }
    }

    internal sealed class EditorForm : Form
    {
        internal const string EditorVirtualUrl = "https://jhl.local/editor.html";

        private const string Bridge = @"
(function () {
    if (window.top !== window || location.href.toLowerCase() !== 'https://jhl.local/editor.html') return;
    var pending = Object.create(null), next = 0;
    function call(method, params) {
        return new Promise(function (resolve, reject) {
            var id = String(++next);
            pending[id] = { resolve: resolve, reject: reject };
            try { chrome.webview.postMessage({ id: id, method: method, params: params || {} }); }
            catch (error) { delete pending[id]; reject(error); }
        });
    }
    window.__JHL_BRIDGE_RESOLVE__ = function (id, ok, payload) {
        var entry = pending[id];
        if (!entry) return;
        delete pending[id];
        if (ok) entry.resolve(payload);
        else entry.reject(new Error(payload));
    };
    window.__JHL_NATIVE__ = {
        discover: function () { return call('discover'); },
        pickAndLoad: function (path) { return call('pickAndLoad', { path: path }); },
        saveFile: function (params) { return call('saveFile', params); },
        listBackups: function (params) { return call('listBackups', params); },
        restoreBackup: function (params) { return call('restoreBackup', params); }
    };
})();";

        private readonly WebView2 view = new WebView2();
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly string root, output, seed;
        private readonly bool selfTest;
        private readonly TestResult result = new TestResult();
        private CoreWebView2 core;

        internal int ExitCode { get; private set; }

        internal EditorForm(string root, bool selfTest, string output, string seed)
        {
            this.root = root;
            this.selfTest = selfTest;
            this.output = output;
            this.seed = seed;
            ExitCode = selfTest ? 1 : 0;
            Text = "Jianghu Chronicles Save Editor";
            ClientSize = new Size(1100, 800);
            view.Dock = DockStyle.Fill;
            Controls.Add(view);
            if (selfTest)
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Opacity = 0;
                ShowInTaskbar = false;
            }
            Shown += Start;
        }

        private async void Start(object sender, EventArgs args)
        {
            try
            {
                await WithTimeout(Initialize());
                if (selfTest) await WithTimeout(RunSelfTest());
            }
            catch (Exception ex)
            {
                ExitCode = 1;
                if (selfTest) Console.Error.WriteLine(ex);
                else MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }

            if (selfTest)
            {
                try
                {
                    Directory.CreateDirectory(output);
                    File.WriteAllText(Path.Combine(output, "selftest-result.json"), json.Serialize(result),
                        new UTF8Encoding(false));
                    ExitCode = result.ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    ExitCode = 1;
                    Console.Error.WriteLine(ex);
                }
            }
            if (selfTest || ExitCode != 0) Close();
        }

        private static async Task WithTimeout(Task task)
        {
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(45))) != task)
                throw new TimeoutException("WebView2 operation timed out.");
            await task;
        }

        internal static bool IsTrustedMessageSource(string uri)
        {
            return string.Equals(uri, EditorVirtualUrl, StringComparison.OrdinalIgnoreCase);
        }

        private async Task Initialize()
        {
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                null, Path.Combine(root, "webview2"));
            result.webViewVersion = environment.BrowserVersionString;
            await view.EnsureCoreWebView2Async(environment);
            core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeResource;
            core.NavigationStarting += FilterNavigation;
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                e.Cancel = true;
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
            };
            core.WebMessageReceived += ReceiveMessage;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(Bridge);

            TaskCompletionSource<bool> navigation = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2NavigationCompletedEventArgs> completed =
                delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
                {
                    if (e.IsSuccess && IsTrustedMessageSource(core.Source)) navigation.TrySetResult(true);
                    else navigation.TrySetException(new IOException("Editor navigation failed: " + e.WebErrorStatus));
                };
            core.NavigationCompleted += completed;
            try
            {
                core.Navigate(EditorVirtualUrl);
                await navigation.Task;
            }
            finally { core.NavigationCompleted -= completed; }
        }

        private void ServeResource(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Stream html = IsTrustedMessageSource(e.Request.Uri) ? Program.OpenResource(Program.Html) : null;
            if (html != null)
                e.Response = core.Environment.CreateWebResourceResponse(html, 200, "OK",
                    "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
            else
                e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
        }

        private static void FilterNavigation(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!IsTrustedMessageSource(e.Uri)) e.Cancel = true;
        }

        private async void ReceiveMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsTrustedMessageSource(e.Source)) return;

            string id = null;
            bool ok;
            object payload;
            try
            {
                IDictionary<string, object> request =
                    json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                id = TextValue(request, "id");
                if (string.IsNullOrEmpty(id)) return;
                object parameters;
                request.TryGetValue("params", out parameters);
                payload = Dispatch(TextValue(request, "method"), parameters as IDictionary<string, object>);
                ok = true;
            }
            catch (Exception ex)
            {
                if (string.IsNullOrEmpty(id)) return;
                payload = ex.Message;
                ok = false;
            }

            try
            {
                if (!IsDisposed && IsTrustedMessageSource(core.Source))
                    await core.ExecuteScriptAsync("window.__JHL_BRIDGE_RESOLVE__(" + Js(id) + "," +
                        (ok ? "true" : "false") + "," + Js(payload) + ");");
            }
            catch (Exception ex) { Console.Error.WriteLine(ex); }
        }

        private string Js(object value)
        {
            return json.Serialize(value).Replace("\u2028", "\\u2028").Replace("\u2029", "\\u2029");
        }

        private static string TextValue(IDictionary<string, object> values, string key)
        {
            object value;
            return values != null && values.TryGetValue(key, out value) ? value as string : null;
        }

        private object Dispatch(string method, IDictionary<string, object> parameters)
        {
            string path = TextValue(parameters, "path");
            switch (method)
            {
                case "discover":
                    return new { files = Discover() };
                case "pickAndLoad":
                    if (string.IsNullOrWhiteSpace(path))
                        using (OpenFileDialog dialog = new OpenFileDialog { Filter = "Save files (*.sav)|*.sav|All files (*.*)|*.*" })
                        {
                            if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                            path = dialog.FileName;
                        }
                    return LoadResponse(Path.GetFullPath(path));
                case "saveFile":
                    if (string.IsNullOrWhiteSpace(path))
                        using (SaveFileDialog dialog = new SaveFileDialog
                        {
                            Filter = "Save files (*.sav)|*.sav|All files (*.*)|*.*",
                            DefaultExt = "sav"
                        })
                        {
                            if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                            path = dialog.FileName;
                        }
                    return SaveStore.SaveWithBackup(path,
                        Convert.FromBase64String(TextValue(parameters, "bytesBase64")),
                        TextValue(parameters, "baseSha256"));
                case "listBackups":
                    return new { backups = SaveStore.ListBackups(path) };
                case "restoreBackup":
                    return SaveStore.RestoreBackup(path, TextValue(parameters, "backupPath"),
                        TextValue(parameters, "baseSha256"));
                default:
                    throw new ArgumentException("Unknown bridge method.");
            }
        }

        private string[] Discover()
        {
            HashSet<string> files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (seed != null && File.Exists(seed)) files.Add(seed);
            string[] directories = {
                Environment.CurrentDirectory, AppDomain.CurrentDomain.BaseDirectory,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "JianghuChronicles"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JianghuChronicles")
            };
            foreach (string directory in directories)
            {
                if (!Directory.Exists(directory)) continue;
                try { files.UnionWith(Directory.GetFiles(directory, "*.sav")); }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
            string[] result = new string[files.Count];
            files.CopyTo(result);
            Array.Sort(result, StringComparer.OrdinalIgnoreCase);
            return result;
        }

        private static object LoadResponse(string path)
        {
            byte[] bytes = File.ReadAllBytes(path);
            return new { path = path, sha256 = SaveStore.Hash(bytes), bytesBase64 = Convert.ToBase64String(bytes) };
        }

        private async Task<bool> VerifyNavigationBlock(string uri)
        {
            TaskCompletionSource<bool> observed = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2NavigationStartingEventArgs> handler =
                delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
                {
                    if (string.Equals(e.Uri, uri, StringComparison.OrdinalIgnoreCase))
                        observed.TrySetResult(e.Cancel);
                };
            core.NavigationStarting += handler;
            try
            {
                core.Navigate(uri);
                return await observed.Task && IsTrustedMessageSource(core.Source);
            }
            finally { core.NavigationStarting -= handler; }
        }

        private async Task RunSelfTest()
        {
            Directory.CreateDirectory(output);
            string seedBytes = seed == null ? null : Convert.ToBase64String(File.ReadAllBytes(seed));
            string script = @"
(function (seed) {
    window.__JHL_TEST_RESULT__ = null;
    function bytes(value) {
        if (typeof value === 'string') return Uint8Array.from(atob(value), function (c) { return c.charCodeAt(0); });
        if (value && value.bytesBase64) return bytes(value.bytesBase64);
        if (value && value.bytes) return bytes(value.bytes);
        return new Uint8Array(value);
    }
    function encode(value) {
        var data = bytes(value), chunks = [];
        for (var i = 0; i < data.length; i += 8192)
            chunks.push(String.fromCharCode.apply(null, data.subarray(i, i + 8192)));
        return btoa(chunks.join(''));
    }
    var report = {};
    Promise.resolve().then(async function () {
        var badge = document.getElementById('runtime-badge');
        report.badgeText = badge ? badge.textContent.trim() : '';
        report.tabCount = document.querySelectorAll('[role=tab]').length;
        var text = document.body.innerText || '';
        report.hanziCount = (text.match(new RegExp('\\p{Script=Han}', 'gu')) || []).length;
        report.kanaCount = (text.match(new RegExp('[\\p{Script=Hiragana}\\p{Script=Katakana}]', 'gu')) || []).length;
        var app = window.JhlEditorApp;
        var original = seed ? bytes(seed) : bytes(window.JhlEditorCore.createDemoNrbfBytes());
        report.original = encode(original);
        var loaded = await app.loadBytes(original);
        if (loaded === false || (loaded && loaded.ok === false)) throw new Error('Load failed');
        var applied = await app.applyPreset('wealth');
        if (applied === false || (applied && applied.ok === false)) throw new Error('Preset failed');
        report.exported = encode(await app.exportBytes());
        if (!report.exported || report.exported === report.original) throw new Error('Preset did not change the save');
        loaded = await app.loadBytes(bytes(report.exported));
        if (loaded === false || (loaded && loaded.ok === false)) throw new Error('Export reload failed');
        report.validateOk = true;
    }).catch(function (error) {
        report.error = String(error);
    }).then(function () { window.__JHL_TEST_RESULT__ = report; });
})(" + Js(seedBytes) + ");";
            await core.ExecuteScriptAsync(script);

            string response = "null";
            for (int attempt = 0; attempt < 100 && response == "null"; attempt++)
            {
                response = await core.ExecuteScriptAsync("window.__JHL_TEST_RESULT__");
                if (response == "null") await Task.Delay(50);
            }
            Dictionary<string, object> report = json.Deserialize<Dictionary<string, object>>(response);
            if (report == null) throw new TimeoutException("Editor script did not finish.");

            result.badgeText = TextValue(report, "badgeText");
            result.tabCount = CountValue(report, "tabCount");
            result.hanziCount = CountValue(report, "hanziCount");
            result.kanaCount = CountValue(report, "kanaCount");
            object valid;
            result.validateOk = report.TryGetValue("validateOk", out valid) && object.Equals(valid, true);
            string error = TextValue(report, "error");
            if (error != null) Console.Error.WriteLine(error);

            if (result.validateOk) VerifySave(report);
            result.senderGuardVerified = IsTrustedMessageSource(EditorVirtualUrl) &&
                IsTrustedMessageSource(EditorVirtualUrl.ToUpperInvariant()) &&
                !IsTrustedMessageSource(null) && !IsTrustedMessageSource("https://example.com/") &&
                !IsTrustedMessageSource(EditorVirtualUrl + "?test=1") &&
                !IsTrustedMessageSource(EditorVirtualUrl + "#test");

            bool dataBlocked = await VerifyNavigationBlock("data:text/html");
            bool externalBlocked = await VerifyNavigationBlock("https://example.com/");
            result.navBlocked = dataBlocked && externalBlocked;
            result.ok = result.badgeText == "네이티브 연결됨" && result.tabCount == 6 &&
                result.hanziCount == 0 && result.kanaCount == 0 && result.navBlocked &&
                result.senderGuardVerified && result.backupExists && result.validateOk && result.conflictBlocked;
        }

        private static int CountValue(IDictionary<string, object> report, string key)
        {
            object value;
            return report.TryGetValue(key, out value) ? Convert.ToInt32(value, CultureInfo.InvariantCulture) : -1;
        }

        private void VerifySave(IDictionary<string, object> report)
        {
            string path = Path.Combine(output, "selftest-" + Guid.NewGuid().ToString("N") + ".sav");
            byte[] original = Convert.FromBase64String(TextValue(report, "original"));
            byte[] exported = Convert.FromBase64String(TextValue(report, "exported"));
            SaveStore.SaveResult initial = SaveStore.SaveWithBackup(path, original, null);
            SaveStore.SaveResult saved = SaveStore.SaveWithBackup(path, exported, initial.sha256);
            result.backupExists = File.Exists(saved.backupPath) &&
                SaveStore.Hash(File.ReadAllBytes(saved.backupPath)) == initial.sha256;
            result.validateOk = saved.sha256 == SaveStore.Hash(exported) &&
                SaveStore.Hash(File.ReadAllBytes(path)) == saved.sha256;
            try { SaveStore.SaveWithBackup(path, original, initial.sha256); }
            catch (SaveStore.ConflictException)
            {
                result.conflictBlocked = SaveStore.Hash(File.ReadAllBytes(path)) == saved.sha256;
            }
        }

        private sealed class TestResult
        {
            public bool ok { get; set; }
            public string webViewVersion { get; set; }
            public int tabCount { get; set; }
            public string badgeText { get; set; }
            public int hanziCount { get; set; }
            public int kanaCount { get; set; }
            public bool navBlocked { get; set; }
            public bool senderGuardVerified { get; set; }
            public bool backupExists { get; set; }
            public bool validateOk { get; set; }
            public bool conflictBlocked { get; set; }
        }
    }

    internal static class SaveStore
    {
        internal sealed class ConflictException : IOException
        {
            internal ConflictException() : base("The save changed since it was loaded.") { }
        }

        internal sealed class SaveResult
        {
            public string path { get; set; }
            public string sha256 { get; set; }
            public string backupPath { get; set; }
        }

        internal static string Hash(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }

        internal static SaveResult SaveWithBackup(string path, byte[] bytes, string baseSha256)
        {
            path = Path.GetFullPath(path);
            string hash = Hash(bytes);
            string prefix = path + ".";
            string temporary = prefix + Guid.NewGuid().ToString("N") + ".tmp";
            string backup = null;
            using (FileStream gate = new FileStream(path + ".jhl-lock", FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose))
            {
                bool exists = File.Exists(path);
                if (!string.IsNullOrEmpty(baseSha256) &&
                    (!exists || !string.Equals(Hash(File.ReadAllBytes(path)), baseSha256, StringComparison.OrdinalIgnoreCase)))
                    throw new ConflictException();

                try
                {
                    using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write))
                    {
                        file.Write(bytes, 0, bytes.Length);
                        file.Flush(true);
                    }
                    if (exists)
                    {
                        backup = prefix + DateTime.UtcNow.ToString("yyyyMMddHHmmssfffffff", CultureInfo.InvariantCulture) +
                            "." + Guid.NewGuid().ToString("N") + ".bak";
                        File.Replace(temporary, path, backup);
                    }
                    else
                        File.Move(temporary, path);
                }
                finally { File.Delete(temporary); }
            }
            return new SaveResult { path = path, sha256 = hash, backupPath = backup };
        }

        internal static string[] ListBackups(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return new string[0];
            path = Path.GetFullPath(path);
            string directory = Path.GetDirectoryName(path);
            if (!Directory.Exists(directory)) return new string[0];

            List<string> backups = new List<string>();
            foreach (string candidate in Directory.GetFiles(directory, "*.bak"))
            {
                string prefix = path + ".";
                if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                string[] parts = candidate.Substring(prefix.Length).Split('.');
                DateTime timestamp;
                Guid id;
                if (parts.Length == 3 && parts[2].Equals("bak", StringComparison.OrdinalIgnoreCase) &&
                    DateTime.TryParseExact(parts[0], "yyyyMMddHHmmssfffffff", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out timestamp) && Guid.TryParseExact(parts[1], "N", out id))
                    backups.Add(candidate);
            }
            backups.Sort(StringComparer.OrdinalIgnoreCase);
            backups.Reverse();
            return backups.ToArray();
        }

        internal static object RestoreBackup(string path, string backupPath, string baseSha256)
        {
            backupPath = Path.GetFullPath(backupPath);
            if (!Array.Exists(ListBackups(path),
                candidate => string.Equals(candidate, backupPath, StringComparison.OrdinalIgnoreCase)))
                throw new IOException("The selected backup does not belong to this save.");

            byte[] bytes = File.ReadAllBytes(backupPath);
            SaveResult saved = SaveWithBackup(path, bytes, baseSha256);
            return new { path = saved.path, sha256 = saved.sha256, bytesBase64 = Convert.ToBase64String(bytes) };
        }
    }
}