param([switch]$ValidateOnly, [switch]$ValidateHook, [int]$ParentPid = 0)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Threading;
using System.Runtime.InteropServices;

public static class PhantomAltTabHook
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int VK_TAB = 0x09;
    private const int VK_MENU = 0x12;
    private const int VK_LMENU = 0xA4;
    private const int VK_RMENU = 0xA5;
    private const int VK_CONTROL = 0x11;
    private const int VK_SHIFT = 0x10;
    private const int VK_ESCAPE = 0x1B;
    private const int VK_F12 = 0x7B;
    private const int VK_LEFT = 0x25;
    private const int VK_UP = 0x26;
    private const int VK_RIGHT = 0x27;
    private const int VK_DOWN = 0x28;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;
    private const uint WM_QUIT = 0x0012;
    private const uint PM_NOREMOVE = 0x0000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint LLKHF_ALTDOWN = 0x20;
    private static readonly LowLevelKeyboardProc Callback = HookCallback;
    private static IntPtr hook;
    private static int parentProcessId;
    private static bool suppressTabUp;
    private static bool suppressF12Up;
    private static bool suppressEscapeUp;
    private static bool switcherActive;
    private static int suppressWindowsArrowUp;
    private static bool leftWindowsKeyDown;
    private static bool rightWindowsKeyDown;

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardData
    {
        public uint virtualKey;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static bool IsDown(int virtualKey)
    {
        return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
    }

    private static bool IsAltKey(int virtualKey)
    {
        return virtualKey == VK_MENU || virtualKey == VK_LMENU || virtualKey == VK_RMENU;
    }

    private static bool IsParentForeground()
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        uint foregroundProcessId;
        GetWindowThreadProcessId(foreground, out foregroundProcessId);
        return foregroundProcessId == (uint)parentProcessId;
    }

    private static void Emit(string message)
    {
        try
        {
            Console.WriteLine(message);
            Console.Out.Flush();
        }
        catch (System.IO.IOException)
        {
            Environment.Exit(1);
        }
    }

    private static IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            int message = wParam.ToInt32();
            bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
            KeyboardData data = (KeyboardData)Marshal.PtrToStructure(lParam, typeof(KeyboardData));
            int key = unchecked((int)data.virtualKey);

            if (!IsParentForeground())
            {
                if (switcherActive)
                {
                    switcherActive = false;
                    Emit("SWITCHER_CANCEL");
                }
                suppressTabUp = false;
                suppressF12Up = false;
                suppressEscapeUp = false;
                suppressWindowsArrowUp = 0;
                leftWindowsKeyDown = false;
                rightWindowsKeyDown = false;
                return CallNextHookEx(hook, code, wParam, lParam);
            }

            if (down && key == VK_LWIN) leftWindowsKeyDown = true;
            else if (up && key == VK_LWIN) leftWindowsKeyDown = false;
            else if (down && key == VK_RWIN) rightWindowsKeyDown = true;
            else if (up && key == VK_RWIN) rightWindowsKeyDown = false;

            if (down && key == VK_F12 && IsDown(VK_CONTROL) && IsDown(VK_SHIFT))
            {
                suppressF12Up = true;
                if (switcherActive)
                {
                    switcherActive = false;
                    Emit("SWITCHER_CANCEL");
                }
                Emit("EXIT");
                return new IntPtr(1);
            }
            if (up && key == VK_F12 && suppressF12Up)
            {
                suppressF12Up = false;
                return new IntPtr(1);
            }
            if (switcherActive && down && key == VK_ESCAPE)
            {
                switcherActive = false;
                suppressEscapeUp = true;
                Emit("SWITCHER_CANCEL");
                return new IntPtr(1);
            }
            if (up && key == VK_ESCAPE && suppressEscapeUp)
            {
                suppressEscapeUp = false;
                return new IntPtr(1);
            }
            if (down && (key == VK_LEFT || key == VK_UP || key == VK_RIGHT || key == VK_DOWN)
                && (leftWindowsKeyDown || rightWindowsKeyDown))
            {
                suppressWindowsArrowUp = key;
                Emit(key == VK_LEFT ? "SNAP_LEFT" : key == VK_RIGHT ? "SNAP_RIGHT" : key == VK_UP ? "SNAP_UP" : "SNAP_DOWN");
                return new IntPtr(1);
            }
            if (up && key == suppressWindowsArrowUp && suppressWindowsArrowUp != 0)
            {
                suppressWindowsArrowUp = 0;
                return new IntPtr(1);
            }
            if (key == VK_TAB && down && (data.flags & LLKHF_ALTDOWN) != 0)
            {
                suppressTabUp = true;
                switcherActive = true;
                Emit(IsDown(VK_SHIFT) ? "SWITCHER_STEP_REVERSE" : "SWITCHER_STEP_FORWARD");
                return new IntPtr(1);
            }
            if (key == VK_TAB && up && suppressTabUp)
            {
                suppressTabUp = false;
                return new IntPtr(1);
            }
            if (switcherActive && up && IsAltKey(key))
            {
                switcherActive = false;
                Emit("SWITCHER_COMMIT");
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    public static void ValidateHook()
    {
        LowLevelKeyboardProc passthrough = (code, wParam, lParam) => CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        IntPtr validationHook = SetWindowsHookEx(WH_KEYBOARD_LL, passthrough, IntPtr.Zero, 0);
        if (validationHook == IntPtr.Zero) throw new InvalidOperationException("SetWindowsHookEx validation failed: " + Marshal.GetLastWin32Error());
        if (!UnhookWindowsHookEx(validationHook)) throw new InvalidOperationException("UnhookWindowsHookEx validation failed: " + Marshal.GetLastWin32Error());
    }

    private static void MonitorParent(int parentProcessId, uint threadId)
    {
        IntPtr parent = OpenProcess(SYNCHRONIZE, false, parentProcessId);
        if (parent == IntPtr.Zero)
        {
            PostThreadMessage(threadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
            return;
        }
        try
        {
            WaitForSingleObject(parent, INFINITE);
        }
        finally
        {
            CloseHandle(parent);
        }
        PostThreadMessage(threadId, WM_QUIT, UIntPtr.Zero, IntPtr.Zero);
    }

    public static void Run(int parentProcessId)
    {
        PhantomAltTabHook.parentProcessId = parentProcessId;
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, Callback, IntPtr.Zero, 0);
        if (hook == IntPtr.Zero) throw new InvalidOperationException("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
        uint threadId = GetCurrentThreadId();
        Message pendingMessage;
        PeekMessage(out pendingMessage, IntPtr.Zero, 0, 0, PM_NOREMOVE);
        Thread monitor = new Thread(() => MonitorParent(parentProcessId, threadId));
        monitor.IsBackground = true;
        monitor.Start();
        Emit("READY");
        try
        {
            Message message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
        }
        finally
        {
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }
    }
}
'@

Add-Type -TypeDefinition $source
if ($ValidateHook) {
    [PhantomAltTabHook]::ValidateHook()
} elseif (-not $ValidateOnly) {
    if ($ParentPid -le 0) { throw 'A valid parent process ID is required.' }
    [PhantomAltTabHook]::Run($ParentPid)
}
