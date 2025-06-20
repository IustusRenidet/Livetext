class EnglishGame {
    constructor() {
        this.score = 0;
        this.level = 1;
        this.currentWord = null;
        this.currentCategory = 'all';
        
        this.vocabulary = {
            animals: [
                { word: 'Cat', options: ['Gato', 'Perro', 'Pájaro', 'Ratón'], correctAnswer: 'Gato', image: '🐱' },
                { word: 'Dog', options: ['Gato', 'Perro', 'Conejo', 'Pez'], correctAnswer: 'Perro', image: '🐕' },
                { word: 'Bird', options: ['Gato', 'Perro', 'Pájaro', 'Pez'], correctAnswer: 'Pájaro', image: '🦜' },
                { word: 'Fish', options: ['Pez', 'Delfín', 'Tiburón', 'Ballena'], correctAnswer: 'Pez', image: '🐠' },
                { word: 'Lion', options: ['León', 'Tigre', 'Pantera', 'Jaguar'], correctAnswer: 'León', image: '🦁' }
            ],
            colors: [
                { word: 'Red', options: ['Rojo', 'Azul', 'Verde', 'Amarillo'], correctAnswer: 'Rojo', image: '🔴' },
                { word: 'Blue', options: ['Rojo', 'Azul', 'Verde', 'Amarillo'], correctAnswer: 'Azul', image: '🔵' },
                { word: 'Green', options: ['Rojo', 'Azul', 'Verde', 'Amarillo'], correctAnswer: 'Verde', image: '🟢' },
                { word: 'Yellow', options: ['Rojo', 'Azul', 'Verde', 'Amarillo'], correctAnswer: 'Amarillo', image: '🟡' }
            ],
            food: [
                { word: 'Apple', options: ['Manzana', 'Pera', 'Plátano', 'Naranja'], correctAnswer: 'Manzana', image: '🍎' },
                { word: 'Banana', options: ['Manzana', 'Pera', 'Plátano', 'Naranja'], correctAnswer: 'Plátano', image: '🍌' },
                { word: 'Pizza', options: ['Pizza', 'Hamburguesa', 'Hot Dog', 'Sándwich'], correctAnswer: 'Pizza', image: '🍕' }
            ]
        };
        
        this.initGame();
        this.createCategoryButtons();
    }

    createCategoryButtons() {
        const categories = {
            'all': 'Todas',
            'animals': 'Animales',
            'colors': 'Colores',
            'food': 'Comida'
        };
    
        const container = document.getElementById('categories');
        if (container) {
            container.innerHTML = '';
            Object.entries(categories).forEach(([key, value]) => {
                const button = document.createElement('button');
                button.className = 'category-btn animate__animated animate__fadeIn';
                button.textContent = value;
                button.onclick = () => this.selectCategory(key);
                if (key === this.currentCategory) button.classList.add('active');
                container.appendChild(button);
            });
        }
    }

    selectCategory(category) {
        this.currentCategory = category;
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.remove('active', 'animate__pulse');
            if (btn.textContent === this.getCategoryName(category)) {
                btn.classList.add('active', 'animate__animated', 'animate__pulse');
            }
        });
        this.showNextWord();
    }

    getCategoryName(category) {
        const categories = {
            'all': 'Todas',
            'animals': 'Animales',
            'colors': 'Colores',
            'food': 'Comida'
        };
        return categories[category];
    }

    getWords() {
        if (this.currentCategory === 'all') {
            return Object.values(this.vocabulary).flat();
        }
        return this.vocabulary[this.currentCategory];
    }

    initGame() {
        this.updateUI();
        this.showNextWord();
    }

    showNextWord() {
        const words = this.getWords();
        this.currentWord = words[Math.floor(Math.random() * words.length)];
        
        const wordDisplay = document.getElementById('word-display');
        const imageContainer = document.getElementById('image-container');
        const optionsContainer = document.getElementById('options-container');

        if (wordDisplay && imageContainer && optionsContainer) {
            wordDisplay.textContent = this.currentWord.word;
            wordDisplay.classList.add('animate__animated', 'animate__bounceIn');
            imageContainer.innerHTML = `<span style="font-size: 100px;">${this.currentWord.image}</span>`;
            imageContainer.classList.add('animate__animated', 'animate__zoomIn');
            
            optionsContainer.innerHTML = '';
            const shuffledOptions = this.shuffleArray([...this.currentWord.options]);
            
            shuffledOptions.forEach(option => {
                const button = document.createElement('button');
                button.className = 'option-btn animate__animated animate__fadeInUp';
                button.textContent = option;
                button.onclick = () => this.checkAnswer(option);
                optionsContainer.appendChild(button);
            });

            // Remove animation classes after animation completes
            setTimeout(() => {
                wordDisplay.classList.remove('animate__animated', 'animate__bounceIn');
                imageContainer.classList.remove('animate__animated', 'animate__zoomIn');
                document.querySelectorAll('.option-btn').forEach(btn => {
                    btn.classList.remove('animate__animated', 'animate__fadeInUp');
                });
            }, 1000);
        }
    }

    checkAnswer(selectedAnswer) {
        const buttons = document.querySelectorAll('.option-btn');
        buttons.forEach(button => button.disabled = true);
        
        const isCorrect = selectedAnswer === this.currentWord.correctAnswer;
        const selectedButton = Array.from(buttons).find(btn => btn.textContent === selectedAnswer);
        
        if (isCorrect) {
            selectedButton.classList.add('correct', 'animate__animated', 'animate__tada');
            this.score += 10;
            if (this.score % 50 === 0) {
                this.level++;
            }
        } else {
            selectedButton.classList.add('incorrect', 'animate__animated', 'animate__shakeX');
            const correctButton = Array.from(buttons).find(btn => 
                btn.textContent === this.currentWord.correctAnswer);
            if (correctButton) {
                correctButton.classList.add('correct', 'animate__animated', 'animate__tada');
            }
        }
        
        this.updateUI();
        
        setTimeout(() => {
            buttons.forEach(button => {
                button.classList.remove('correct', 'incorrect', 'animate__animated', 'animate__tada', 'animate__shakeX');
                button.disabled = false;
            });
            this.showNextWord();
        }, 1500);
    }

    updateUI() {
        const scoreElement = document.getElementById('score');
        const levelElement = document.getElementById('level');
        
        if (scoreElement) {
            scoreElement.textContent = this.score;
            scoreElement.parentElement.classList.add('animate__animated', 'animate__pulse');
            setTimeout(() => scoreElement.parentElement.classList.remove('animate__animated', 'animate__pulse'), 1000);
        }
        if (levelElement) {
            levelElement.textContent = this.level;
            levelElement.parentElement.classList.add('animate__animated', 'animate__pulse');
            setTimeout(() => levelElement.parentElement.classList.remove('animate__animated', 'animate__pulse'), 1000);
        }
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new EnglishGame();
});