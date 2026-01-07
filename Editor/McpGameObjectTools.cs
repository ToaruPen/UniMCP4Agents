#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UniMCP4CC.Editor
{
  internal static class McpGameObjectTools
  {
    [Serializable]
    private sealed class ResultPayload
    {
      public string status;
      public string message;
      public string name;
      public string parentPath;
      public string gameObjectPath;
      public int candidateCount;
      public string[] candidatePaths;
    }

    public static string CreateEmptySafeBase64(string name, string parentPath, bool active)
    {
      string EncodeResult(string status, string message, Action<ResultPayload> configure = null)
      {
        var payload = new ResultPayload
        {
          status = status,
          message = message,
          name = name,
          parentPath = parentPath,
        };

        configure?.Invoke(payload);

        return Encode(payload);
      }

      try
      {
        if (string.IsNullOrWhiteSpace(name))
        {
          return EncodeResult("error", "name is required");
        }

        var trimmedName = name.Trim();
        GameObject parent = null;
        var trimmedParentPath = string.IsNullOrWhiteSpace(parentPath) ? string.Empty : parentPath.Trim();
        if (!string.IsNullOrEmpty(trimmedParentPath))
        {
          var matches = FindSceneGameObjectsByQuery(trimmedParentPath);
          if (matches.Count == 0)
          {
            return EncodeResult("error", $"Parent GameObject not found: {trimmedParentPath}");
          }

          if (matches.Count > 1)
          {
            var candidatePaths = BuildCandidatePaths(matches, maxCandidates: 10);
            var messageBuilder = new StringBuilder();
            messageBuilder.Append($"Parent GameObject is ambiguous: {trimmedParentPath}");
            messageBuilder.Append("\nCandidates:");
            for (var index = 0; index < candidatePaths.Length; index++)
            {
              messageBuilder.Append("\n- ");
              messageBuilder.Append(candidatePaths[index]);
            }
            messageBuilder.Append("\nSpecify a full hierarchy path (e.g. \"Root/Child\").");

            return EncodeResult(
              "error",
              messageBuilder.ToString(),
              payload =>
              {
                payload.candidateCount = matches.Count;
                payload.candidatePaths = candidatePaths;
              }
            );
          }

          parent = matches[0];
          if (parent == null)
          {
            return EncodeResult("error", $"Parent GameObject not found: {trimmedParentPath}");
          }
        }

        var targetScene = ResolveTargetScene(parent);
        if (!targetScene.IsValid() || !targetScene.isLoaded)
        {
          return EncodeResult("error", "No loaded scene available for GameObject creation.");
        }

        var gameObject = new GameObject(trimmedName);
        Undo.RegisterCreatedObjectUndo(gameObject, "Create Empty GameObject");

        if (parent != null)
        {
          SceneManager.MoveGameObjectToScene(gameObject, parent.scene);
          var parentTransform = parent.transform;
          if (parentTransform != null)
          {
            gameObject.transform.SetParent(parentTransform, false);
          }
        }
        else
        {
          SceneManager.MoveGameObjectToScene(gameObject, targetScene);
        }

        gameObject.SetActive(active);
        EditorUtility.SetDirty(gameObject);

        return EncodeResult(
          "success",
          "GameObject created",
          payload =>
          {
            payload.name = gameObject.name;
            payload.parentPath = trimmedParentPath;
            payload.gameObjectPath = GetHierarchyPath(gameObject);
          }
        );
      }
      catch (Exception exception)
      {
        return EncodeResult("error", exception.Message);
      }
    }

    private static Scene ResolveTargetScene(GameObject parent)
    {
      if (parent != null)
      {
        var parentScene = parent.scene;
        if (parentScene.IsValid() && parentScene.isLoaded)
        {
          return parentScene;
        }
      }

      var activeScene = SceneManager.GetActiveScene();
      if (activeScene.IsValid() && activeScene.isLoaded)
      {
        return activeScene;
      }

      foreach (var scene in EnumerateLoadedScenes())
      {
        return scene;
      }

      return default;
    }

    private static List<GameObject> FindSceneGameObjectsByQuery(string query)
    {
      var matches = new List<GameObject>();
      if (string.IsNullOrWhiteSpace(query))
      {
        return matches;
      }

      var trimmed = query.Trim();
      if (trimmed.IndexOf('/') >= 0)
      {
        FindSceneGameObjectsByPath(trimmed, matches);
      }
      else
      {
        FindSceneGameObjectsByName(trimmed, matches);
      }

      return matches;
    }

    private static IEnumerable<Scene> EnumerateLoadedScenes()
    {
      var prefabStage = PrefabStageUtility.GetCurrentPrefabStage();
      var prefabStageScene = prefabStage != null ? prefabStage.scene : default;
      var hasPrefabStageScene = prefabStage != null;

      var sceneCount = SceneManager.sceneCount;
      for (var index = 0; index < sceneCount; index++)
      {
        var scene = SceneManager.GetSceneAt(index);
        if (!scene.IsValid() || !scene.isLoaded)
        {
          continue;
        }

        if (hasPrefabStageScene && scene == prefabStageScene)
        {
          continue;
        }

        yield return scene;
      }
    }

    private static void FindSceneGameObjectsByPath(string path, List<GameObject> matches)
    {
      if (matches == null)
      {
        return;
      }

      var segments = path.Split('/');
      if (segments.Length == 0)
      {
        return;
      }

      var seen = new HashSet<int>();

      foreach (var scene in EnumerateLoadedScenes())
      {
        var roots = scene.GetRootGameObjects();
        var current = new List<GameObject>();
        for (var rootIndex = 0; rootIndex < roots.Length; rootIndex++)
        {
          var root = roots[rootIndex];
          if (root != null && string.Equals(root.name, segments[0], StringComparison.Ordinal))
          {
            current.Add(root);
          }
        }

        for (var segmentIndex = 1; segmentIndex < segments.Length && current.Count > 0; segmentIndex++)
        {
          var next = new List<GameObject>();
          var segment = segments[segmentIndex];
          for (var currentIndex = 0; currentIndex < current.Count; currentIndex++)
          {
            var candidate = current[currentIndex];
            if (candidate == null)
            {
              continue;
            }
            var transform = candidate.transform;
            if (transform == null)
            {
              continue;
            }
            for (var childIndex = 0; childIndex < transform.childCount; childIndex++)
            {
              var child = transform.GetChild(childIndex);
              if (child != null && string.Equals(child.name, segment, StringComparison.Ordinal))
              {
                next.Add(child.gameObject);
              }
            }
          }
          current = next;
        }

        for (var currentIndex = 0; currentIndex < current.Count; currentIndex++)
        {
          var candidate = current[currentIndex];
          if (candidate == null)
          {
            continue;
          }
          if (seen.Add(candidate.GetInstanceID()))
          {
            matches.Add(candidate);
          }
        }
      }
    }

    private static void FindSceneGameObjectsByName(string name, List<GameObject> matches)
    {
      if (matches == null)
      {
        return;
      }

      var seen = new HashSet<int>();
      foreach (var scene in EnumerateLoadedScenes())
      {
        var roots = scene.GetRootGameObjects();
        for (var rootIndex = 0; rootIndex < roots.Length; rootIndex++)
        {
          var root = roots[rootIndex];
          if (root == null)
          {
            continue;
          }
          foreach (var transform in root.GetComponentsInChildren<Transform>(true))
          {
            if (transform == null)
            {
              continue;
            }
            if (!string.Equals(transform.name, name, StringComparison.Ordinal))
            {
              continue;
            }
            var candidate = transform.gameObject;
            if (candidate == null)
            {
              continue;
            }
            if (seen.Add(candidate.GetInstanceID()))
            {
              matches.Add(candidate);
            }
          }
        }
      }
    }

    private static string[] BuildCandidatePaths(List<GameObject> matches, int maxCandidates)
    {
      if (matches == null || matches.Count == 0 || maxCandidates <= 0)
      {
        return Array.Empty<string>();
      }

      var paths = new List<string>(matches.Count);
      var seen = new HashSet<string>(StringComparer.Ordinal);
      for (var index = 0; index < matches.Count; index++)
      {
        var candidate = matches[index];
        if (candidate == null)
        {
          continue;
        }
        var path = GetHierarchyPath(candidate);
        if (string.IsNullOrWhiteSpace(path))
        {
          continue;
        }
        if (seen.Add(path))
        {
          paths.Add(path);
        }
      }

      paths.Sort(StringComparer.Ordinal);
      var count = paths.Count > maxCandidates ? maxCandidates : paths.Count;
      var result = new string[count];
      for (var index = 0; index < count; index++)
      {
        result[index] = paths[index];
      }

      return result;
    }

    private static string GetHierarchyPath(GameObject gameObject)
    {
      if (gameObject == null)
      {
        return string.Empty;
      }

      var transform = gameObject.transform;
      if (transform == null)
      {
        return gameObject.name ?? string.Empty;
      }

      var names = new Stack<string>();
      var current = transform;
      while (current != null)
      {
        names.Push(current.name);
        current = current.parent;
      }

      return string.Join("/", names.ToArray());
    }

    private static string Encode(ResultPayload payload)
    {
      var json = JsonUtility.ToJson(payload);
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
    }
  }
}
#endif
