#if UNITY_EDITOR
using System;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using Process = System.Diagnostics.Process;

namespace UniMCP4CC.Editor
{
  [InitializeOnLoad]
  internal static class McpServerAutoStart
  {
    private const string MenuItemPath = "MCP/Server/Start";
    private const string ToggleMenuItemPath = "MCP/Server/Auto Start";
    private const string RuntimeConfigFileName = ".unity-mcp-runtime.json";
    private const string AutoStartInBatchModeEnvVar = "UNITY_MCP_AUTOSTART_IN_BATCHMODE";
    private const string EditorPrefsAutoStartKey = "UniMCP4CC.McpServerAutoStart.Enabled";
    private const int MaxAttempts = 10;
    private const int HealthConnectTimeoutMs = 250;

    private static int s_attemptCount;
    private static double s_nextAttemptTime;
    private static bool s_isSubscribed;

    static McpServerAutoStart()
    {
      if (Application.isBatchMode)
      {
        if (!IsBatchModeAutoStartEnabled())
        {
          return;
        }
      }
      else if (!IsEditorAutoStartEnabled())
      {
        return;
      }

      s_attemptCount = 0;
      s_nextAttemptTime = EditorApplication.timeSinceStartup + 2.0;
      Subscribe();
    }

    [MenuItem(ToggleMenuItemPath)]
    private static void ToggleAutoStart()
    {
      bool nextEnabled = !IsEditorAutoStartEnabled();
      EditorPrefs.SetBool(EditorPrefsAutoStartKey, nextEnabled);

      if (nextEnabled)
      {
        s_attemptCount = 0;
        s_nextAttemptTime = EditorApplication.timeSinceStartup + 0.5;
        Subscribe();
      }
      else
      {
        Unsubscribe();
      }

      Debug.Log($"[MCP] AutoStart: {(nextEnabled ? "enabled" : "disabled")} (EditorPrefs: {EditorPrefsAutoStartKey})");
    }

    [MenuItem(ToggleMenuItemPath, validate = true)]
    private static bool ToggleAutoStartValidate()
    {
      Menu.SetChecked(ToggleMenuItemPath, IsEditorAutoStartEnabled());
      return !Application.isBatchMode;
    }

    private static bool IsEditorAutoStartEnabled()
    {
      return EditorPrefs.GetBool(EditorPrefsAutoStartKey, true);
    }

    private static bool IsBatchModeAutoStartEnabled()
    {
      var value = Environment.GetEnvironmentVariable(AutoStartInBatchModeEnvVar);
      if (string.IsNullOrWhiteSpace(value))
      {
        return false;
      }

      switch (value.Trim().ToLowerInvariant())
      {
        case "1":
        case "true":
        case "yes":
        case "y":
        case "on":
          return true;
        default:
          return false;
      }
    }

    private static void Subscribe()
    {
      if (s_isSubscribed)
      {
        return;
      }

      EditorApplication.update += Tick;
      s_isSubscribed = true;
    }

    private static void Unsubscribe()
    {
      if (!s_isSubscribed)
      {
        return;
      }

      EditorApplication.update -= Tick;
      s_isSubscribed = false;
    }

    private static void Tick()
    {
      if (EditorApplication.timeSinceStartup < s_nextAttemptTime)
      {
        return;
      }

      if (EditorApplication.isCompiling || EditorApplication.isUpdating)
      {
        s_nextAttemptTime = EditorApplication.timeSinceStartup + 2.0;
        return;
      }

      if (IsRuntimeConfigFreshForThisProcess())
      {
        Unsubscribe();
        return;
      }

      if (s_attemptCount >= MaxAttempts)
      {
        Unsubscribe();
        Debug.LogWarning($"[MCP] AutoStart: failed to start server after {MaxAttempts} attempts. Use menu: {MenuItemPath}");
        return;
      }

      s_attemptCount++;
      EditorApplication.ExecuteMenuItem(MenuItemPath);

      var delaySeconds = Math.Min(15.0, 1.0 + s_attemptCount * 1.5);
      s_nextAttemptTime = EditorApplication.timeSinceStartup + delaySeconds;
    }

    private static bool IsRuntimeConfigFreshForThisProcess()
    {
      try
      {
        var projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        var runtimeConfigPath = Path.Combine(projectRoot, RuntimeConfigFileName);
        if (!File.Exists(runtimeConfigPath))
        {
          return false;
        }

        var json = File.ReadAllText(runtimeConfigPath);
        var config = JsonUtility.FromJson<RuntimeConfig>(json);
        if (config == null)
        {
          return false;
        }

        if (config.processId != Process.GetCurrentProcess().Id || config.httpPort <= 0)
        {
          return false;
        }

        return IsLocalPortListening(config.httpPort, HealthConnectTimeoutMs);
      }
      catch
      {
        return false;
      }
    }

    private static bool IsLocalPortListening(int port, int timeoutMs)
    {
      try
      {
        using (var client = new TcpClient())
        {
          Task connectTask = client.ConnectAsync("127.0.0.1", port);
          if (!connectTask.Wait(timeoutMs))
          {
            return false;
          }

          return client.Connected;
        }
      }
      catch
      {
        return false;
      }
    }

    [Serializable]
    private sealed class RuntimeConfig
    {
      public int processId;
      public int httpPort;
    }
  }
}
#endif
