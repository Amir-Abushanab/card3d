package com.card3d.example

import android.app.Activity
import android.content.ActivityNotFoundException
import android.graphics.Color
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import com.card3d.ArFormat
import com.card3d.Card3DException
import com.card3d.CardFit
import com.card3d.CardStage
import com.card3d.CardView
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File

/**
 * The library's example: a design picker over the preset designs (the Swift example's), the card,
 * and flip, reset, PNG and AR buttons. `adb shell am start -n com.card3d.example/.MainActivity -e preset
 * holo-front` picks the first design.
 */
class MainActivity : Activity() {
  private val scope = MainScope()
  private lateinit var stage: CardStage
  private lateinit var status: TextView
  private var loading: Job? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val presets = assets.list("").orEmpty().filter { it.endsWith(".json") }.map { it.removeSuffix(".json") }.sorted()
    stage = CardStage(this, CardStage.Options(fit = CardFit.CONTAIN))

    val picker = Spinner(this).apply {
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, presets)
      val first = presets.indexOf(intent.getStringExtra("preset") ?: "holo-front")
      setSelection(if (first >= 0) first else 0)
      onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = show(presets[position])
        override fun onNothingSelected(parent: AdapterView<*>?) = Unit
      }
    }
    val card = CardView(this).apply { stage = this@MainActivity.stage }
    status = TextView(this).apply {
      setTextColor(Color.LTGRAY)
      gravity = Gravity.CENTER
    }
    val buttons = LinearLayout(this).apply {
      gravity = Gravity.CENTER
      addView(button("Flip") { stage.flip() })
      addView(button("Reset") { stage.reset() })
      addView(button("PNG") { exportPng() })
      addView(button("AR") { showAr() })
    }
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.rgb(24, 24, 27))
      addView(picker)
      addView(card, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
      addView(status)
      addView(buttons)
      // Edge to edge (target SDK 35+): keep the controls clear of the system bars.
      setOnApplyWindowInsetsListener { v, insets ->
        val bars = insets.getInsets(WindowInsets.Type.systemBars())
        v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        insets
      }
    }
    setContentView(root)
    stage.addListener { s ->
      status.text = when {
        s.isLoading -> "Loading…"
        s.lastError != null -> "Error: ${s.lastError?.message}"
        else -> s.report?.let { r -> "${if (s.isFlipped) "Back" else "Front"} · ${r.errors.size} errors, ${r.warnings.size} warnings" } ?: ""
      }
    }
  }

  private fun button(label: String, action: () -> Unit) = Button(this).apply {
    text = label
    setOnClickListener { action() }
  }

  private fun show(preset: String) {
    loading?.cancel()
    loading = scope.launch {
      try {
        val json = assets.open("$preset.json").bufferedReader().use { it.readText() }
        stage.setDesign(json)
      } catch (e: Card3DException) {
        Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
      }
    }
  }

  private fun exportPng() {
    try {
      val png = stage.exportPng(1200, 750)
      val file = File(getExternalFilesDir(Environment.DIRECTORY_PICTURES), "card.png").apply { writeBytes(png) }
      Toast.makeText(this, "Saved ${file.path} (${png.size / 1024} KB)", Toast.LENGTH_LONG).show()
    } catch (e: Card3DException) {
      Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
    }
  }

  private fun showAr() {
    try {
      val glb = stage.exportArFile(ArFormat.GLB, size = 1024)
      startActivity(CardStage.arIntent(this, glb, title = "Card"))
    } catch (e: Card3DException) {
      Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
    } catch (e: ActivityNotFoundException) {
      Toast.makeText(this, "No app shows 3D models here (Scene Viewer comes with Google Play Services for AR)", Toast.LENGTH_LONG).show()
    }
  }

  override fun onDestroy() {
    scope.cancel()
    stage.close()
    super.onDestroy()
  }
}
