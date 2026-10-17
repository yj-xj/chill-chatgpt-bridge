using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text;
using System.Threading.Tasks;
using BepInEx;
using HarmonyLib;
using UnityEngine;
using UnityEngine.UIElements;

namespace ChillChineseInput
{
    [BepInPlugin(Id, "AIChat Chinese Input", "1.0.0")]
    [BepInDependency("com.username.chillaimod", BepInDependency.DependencyFlags.HardDependency)]
    public sealed class ChineseInputPlugin : BaseUnityPlugin
    {
        public const string Id = "local.chill.aichat.chineseinput";
        private const string ControlName = "ChillChineseInput.ChatDraft";
        private const int MaxLength = 100000;
        private static ChineseInputPlugin instance;
        private FieldInfo inputField;
        private PropertyInfo modInstance;
        private Harmony harmony;
        private Task<string> editor;
        private object editingMod;
        private FieldInfo focusedToolkitField;
        private PropertyInfo toolkitFocusedFlag;
        private TextField toolkitTarget;
        private TextField editingToolkit;
        private IPanel editingPanel;
        private string originalDraft;
        private string recoveredDraft;
        private object recoveredFor;
        private string composerPath;
        private string status;
        private int lastCompositionFrame = -100;

        private void Awake()
        {
            try
            {
                Type mod = AccessTools.TypeByName("ChillAIMod.AIMod");
                inputField = AccessTools.Field(mod, "_playerInput");
                modInstance = mod == null ? null : mod.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
                MethodInfo draw = AccessTools.Method(mod, "DrawWindowContent", new Type[] { typeof(int) });
                MethodInfo onGui = AccessTools.Method(mod, "OnGUI");
                if (inputField == null || inputField.FieldType != typeof(string) || modInstance == null || draw == null || onGui == null)
                    throw new NotSupportedException("Unsupported AIChat input layout");
                composerPath = Path.Combine(Path.GetDirectoryName(Info.Location), "ChillChineseComposer.exe");
                if (!File.Exists(composerPath)) throw new FileNotFoundException("Chinese composer is missing");
                Type dispatcher = AccessTools.TypeByName("ChillPatcher.UIToolkitInputDispatcher");
                if (dispatcher != null)
                {
                    focusedToolkitField = AccessTools.Field(dispatcher, "_currentFocusedTextField");
                    toolkitFocusedFlag = AccessTools.Property(dispatcher, "IsUIToolkitTextFieldFocused");
                }
                instance = this;
                harmony = new Harmony(Id);
                harmony.Patch(draw, null, null, new HarmonyMethod(typeof(ChineseInputPlugin), "TranspileInput"));
                harmony.Patch(onGui, new HarmonyMethod(typeof(ChineseInputPlugin), "BeforeOnGui"));
                Logger.LogInfo("Chinese input ready: native Windows IME editor; no network or automatic sending.");
            }
            catch (Exception error)
            {
                if (harmony != null) harmony.UnpatchSelf();
                instance = null;
                Logger.LogError("Chinese input disabled: " + error.GetType().Name + ". No AIChat file was changed.");
            }
        }

        // Restrict replacement to the only styled TextArea and Return check in AIChat 1.10.0.
        // Refuse unknown layouts instead of guessing which settings field is the chat draft.
        private static IEnumerable<CodeInstruction> TranspileInput(IEnumerable<CodeInstruction> instructions)
        {
            List<CodeInstruction> code = instructions.Select(i => new CodeInstruction(i)).ToList();
            MethodInfo area = AccessTools.Method(typeof(GUILayout), "TextArea", new Type[] { typeof(string), typeof(GUIStyle), typeof(GUILayoutOption[]) });
            MethodInfo key = AccessTools.PropertyGetter(typeof(Event), "keyCode");
            if (code.Count(i => Equals(i.operand, area)) != 1 || code.Count(i => Equals(i.operand, key)) != 1)
                throw new NotSupportedException("Unsupported AIChat input instructions");
            foreach (CodeInstruction instruction in code)
            {
                if (Equals(instruction.operand, area)) instruction.operand = AccessTools.Method(typeof(ChineseInputPlugin), "DrawInput");
                if (Equals(instruction.operand, key))
                {
                    instruction.opcode = OpCodes.Call;
                    instruction.operand = AccessTools.Method(typeof(ChineseInputPlugin), "SendKey");
                }
            }
            return code;
        }

        private static bool BeforeOnGui()
        {
            if (instance == null) return true;
            instance.ObserveComposition();
            // Native editor owns keyboard focus. Do not run the original send shortcuts.
            return instance.editor == null;
        }

        private void ObserveComposition()
        {
            if (!string.IsNullOrEmpty(Input.compositionString)) lastCompositionFrame = Time.frameCount;
        }

        private static KeyCode SendKey(Event current)
        {
            instance.ObserveComposition();
            bool blocked = !MaySend(GUI.GetNameOfFocusedControl() == ControlName,
                !string.IsNullOrEmpty(Input.compositionString), Time.frameCount, instance.lastCompositionFrame,
                instance.editor != null);
            return blocked ? KeyCode.None : current.keyCode;
        }

        public static bool MaySend(bool focused, bool composing, int frame, int lastComposition, bool editorOpen)
        {
            return focused && !composing && !editorOpen && frame - lastComposition > 1;
        }

        private static string DrawInput(string draft, GUIStyle style, GUILayoutOption[] options)
        {
            GUILayout.BeginVertical(options);
            if (GUILayout.Button(new GUIContent("中文输入（系统输入法）", instance.status ?? ""), GUILayout.Height(28f))) instance.OpenEditor(draft, null);
            GUI.SetNextControlName(ControlName);
            string result = GUILayout.TextArea(draft, style, GUILayout.ExpandHeight(true));
            GUILayout.EndVertical();
            return result;
        }

        private void OpenEditor(string draft, TextField toolkit)
        {
            if (editor != null) return;
            editingToolkit = toolkit;
            editingPanel = toolkit == null ? null : toolkit.panel;
            editingMod = toolkit == null ? modInstance.GetValue(null, null) : null;
            if (toolkit == null && editingMod == null) return;
            originalDraft = draft;
            object targetIdentity = (object)toolkit ?? editingMod;
            string initial = ReferenceEquals(recoveredFor, targetIdentity) && recoveredDraft != null ? recoveredDraft : draft;
            if (initial.Length > MaxLength) { status = "草稿过长，请先缩短文字。"; return; }
            status = null;
            // Clear Unity's retained focus so its global clipboard hook does not
            // intercept Ctrl+A/C/V/X intended for the native Windows editor.
            TextField focusedToolkit = focusedToolkitField == null ? null : focusedToolkitField.GetValue(null) as TextField;
            if (focusedToolkit != null && focusedToolkit.panel != null)
            {
                VisualElement focused = focusedToolkit.panel.focusController.focusedElement as VisualElement;
                if (focused != null) focused.Blur();
                focusedToolkit.Blur();
                if (ReferenceEquals(focusedToolkitField.GetValue(null), focusedToolkit))
                {
                    focusedToolkitField.SetValue(null, null);
                    if (toolkitFocusedFlag != null) toolkitFocusedFlag.GetSetMethod(true).Invoke(null, new object[] { false });
                }
            }
            Type hook = AccessTools.TypeByName("ChillPatcher.Patches.KeyboardHookPatch");
            MethodInfo clear = hook == null ? null : AccessTools.Method(hook, "ClearAll");
            if (clear != null) clear.Invoke(null, null);
            int parent = Process.GetCurrentProcess().Id;
            editor = Task.Factory.StartNew(() => RunEditor(initial, parent));
        }

        private string RunEditor(string draft, int parent)
        {
            ProcessStartInfo start = new ProcessStartInfo(composerPath, parent.ToString(System.Globalization.CultureInfo.InvariantCulture));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.WorkingDirectory = Path.GetDirectoryName(composerPath);
            using (Process child = Process.Start(start))
            {
                child.StandardInput.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(draft)));
                child.StandardInput.Close();
                string output = child.StandardOutput.ReadLine();
                child.WaitForExit();
                if (child.ExitCode == 2) return null;
                if (child.ExitCode != 0 || output == null || output.Length > MaxLength * 6) throw new InvalidDataException();
                string result = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(output));
                if (result.Length > MaxLength) throw new InvalidDataException();
                return result;
            }
        }

        private void Update()
        {
            if (instance != this) return;
            if (editor == null && focusedToolkitField != null)
            {
                TextField candidate = focusedToolkitField.GetValue(null) as TextField;
                toolkitTarget = IsEditable(candidate) ? candidate : null;
            }
            if (editor == null || !editor.IsCompleted) return;
            Task<string> finished = editor;
            editor = null;
            if (finished.IsFaulted)
            {
                status = "中文输入窗口未能打开，原草稿已保留。";
                Logger.LogWarning("Native editor failed: " + finished.Exception.GetBaseException().GetType().Name);
            }
            else if (finished.Result != null)
            {
                bool unchanged = editingToolkit != null
                    ? IsEditable(editingToolkit) && ReferenceEquals(editingToolkit.panel, editingPanel) && editingToolkit.value == originalDraft
                    : ReferenceEquals(modInstance.GetValue(null, null), editingMod) && Equals(inputField.GetValue(editingMod), originalDraft);
                if (unchanged)
                {
                    // value's setter dispatches ChangeEvent<string>, updating OneJS state.
                    if (editingToolkit != null) editingToolkit.value = finished.Result;
                    else inputField.SetValue(editingMod, finished.Result);
                    if (ReferenceEquals(recoveredFor, (object)editingToolkit ?? editingMod)) { recoveredDraft = null; recoveredFor = null; }
                    status = "中文已填回，请点击发送。";
                    Logger.LogInfo("Native editor draft transferred; no message sent.");
                }
                else
                {
                    recoveredDraft = finished.Result;
                    recoveredFor = (object)editingToolkit ?? editingMod;
                    status = "原草稿已变化；点击中文输入恢复刚才的文字。";
                }
            }
            editingMod = null;
            editingToolkit = null;
            editingPanel = null;
            originalDraft = null;
        }

        private void OnGUI()
        {
            if (instance != this || editor != null || toolkitTarget == null || toolkitTarget.panel == null) return;
            // OneJS/UIToolkit cards use a different input path from AIChat's F9 console.
            // Keep this launcher independent of the card's generated JavaScript/layout.
            // Activate on pointer-down: UI Toolkit may blur before a later mouse-up.
            if (GUI.RepeatButton(new Rect(12, Screen.height - 54, 260, 38), "中文输入（当前输入框）"))
                OpenEditor(toolkitTarget.value ?? "", toolkitTarget);
        }

        private static bool IsEditable(TextField field)
        {
            return field != null && field.panel != null && field.enabledInHierarchy && field.visible
                && field.resolvedStyle.display != DisplayStyle.None && !field.isReadOnly && !field.isPasswordField;
        }

        private void OnDestroy()
        {
            if (harmony != null) harmony.UnpatchSelf();
            if (instance == this) instance = null;
        }
    }
}
